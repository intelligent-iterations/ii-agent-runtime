import sodium from 'libsodium-wrappers';
import { GitHubError, getRecord, positiveId, record, type GitHubApi } from './http.js';

export type SecretDestination =
  | { kind: 'organization'; organization: string; repositoryIds: number[] }
  | { kind: 'repository'; repository: string };
function prefix(destination: SecretDestination): string {
  if (destination.kind === 'organization') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(destination.organization) || destination.repositoryIds.length < 1 || destination.repositoryIds.length > 100) throw new GitHubError('SECRET_DESTINATION');
    destination.repositoryIds.forEach(positiveId);
    if (new Set(destination.repositoryIds).size !== destination.repositoryIds.length) throw new GitHubError('SECRET_DESTINATION');
    return `/orgs/${destination.organization}/actions/secrets`;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(destination.repository)) throw new GitHubError('SECRET_DESTINATION');
  return `/repos/${destination.repository}/actions/secrets`;
}

/** Never replaces an existing secret unless the caller explicitly asks, for example when rotating a key. */
export async function uploadGitHubSecret(api: GitHubApi, destination: SecretDestination, name: string, value: string, options: { replace?: boolean } = {}) {
  if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(name) || /^(GITHUB_|ACTIONS_|RUNNER_)/.test(name) || !value || Buffer.byteLength(value) > 32768) throw new GitHubError('SECRET_INPUT');
  const root = prefix(destination);
  if (options.replace !== true) {
    const existing = await api.request('GET', `${root}/${name}`);
    if (existing.status === 200) throw new GitHubError('SECRET_EXISTS');
    if (existing.status !== 404) throw new GitHubError('SECRET_PREFLIGHT', existing.status);
  }
  const key = await getRecord(api, `${root}/public-key`);
  if (typeof key.key !== 'string' || typeof key.key_id !== 'string') throw new GitHubError('SECRET_PUBLIC_KEY');
  let encrypted: string;
  await sodium.ready;
  try {
    const bytes = sodium.from_string(value);
    try { encrypted = sodium.to_base64(sodium.crypto_box_seal(bytes, sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL)), sodium.base64_variants.ORIGINAL); }
    finally { sodium.memzero(bytes); }
  } catch { throw new GitHubError('SECRET_ENCRYPTION'); }
  const uploaded = await api.request('PUT', `${root}/${name}`, {
    encrypted_value: encrypted, key_id: key.key_id,
    ...(destination.kind === 'organization' ? { visibility: 'selected', selected_repository_ids: [...destination.repositoryIds].sort((a, b) => a - b) } : {}),
  });
  if (![201, 204].includes(uploaded.status)) throw new GitHubError('SECRET_UPLOAD_UNCONFIRMED', uploaded.status);
  await verifyGitHubSecret(api, destination, name);
  return { name, destination, stored: true as const, launchVerified: false as const };
}

/** Verify exact secret access on every resume, without reading or replacing its value. */
export async function verifyGitHubSecret(api: GitHubApi, destination: SecretDestination, name: string): Promise<void> {
  if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(name) || /^(GITHUB_|ACTIONS_|RUNNER_)/.test(name)) throw new GitHubError('SECRET_INPUT');
  const root = prefix(destination);
  const metadata = await getRecord(api, `${root}/${name}`);
  if (metadata.name !== name) throw new GitHubError('SECRET_METADATA');
  if (destination.kind === 'organization') {
    if (metadata.visibility !== 'selected') throw new GitHubError('SECRET_VISIBILITY');
    const selected = await getRecord(api, `${root}/${name}/repositories?per_page=100`);
    if (!Array.isArray(selected.repositories) || selected.total_count !== destination.repositoryIds.length ||
      JSON.stringify(selected.repositories.map(repo => positiveId(record(repo).id)).sort((a, b) => a - b)) !==
      JSON.stringify([...destination.repositoryIds].sort((a, b) => a - b))) throw new GitHubError('SECRET_REPOSITORY_SCOPE');
  }
}
