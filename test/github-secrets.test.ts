import assert from 'node:assert/strict';
import { test } from 'node:test';
import sodium from 'libsodium-wrappers';
import { createGitHubApi } from '../src/providers/github-http.js';
import { uploadGitHubSecret } from '../src/providers/github-secrets.js';

test('secret upload is independently decryptable, restricted to selected repositories, and reports only storage verification', async () => {
  await sodium.ready;
  const keys = sodium.crypto_box_keypair();
  let saved: any;
  const value = 'synthetic-private-key-value';
  const api = createGitHubApi({ credential: () => 'synthetic-user-token', fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/public-key')) return Response.json({ key_id: 'test-key', key: sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL) });
    if (init?.method === 'PUT') {
      assert.ok(!String(init.body).includes(value));
      saved = JSON.parse(String(init.body));
      return new Response(null, { status: 201 });
    }
    if (path.endsWith('/repositories')) return Response.json({ total_count: 2, repositories: [{ id: 102 }, { id: 101 }] });
    return saved ? Response.json({ name: 'SAMPLE_PRIVATE_KEY', visibility: 'selected' }) : new Response(null, { status: 404 });
  } });
  const result = await uploadGitHubSecret(api, { kind: 'organization', organization: 'example', repositoryIds: [102, 101] }, 'SAMPLE_PRIVATE_KEY', value);
  const decrypted = sodium.crypto_box_seal_open(sodium.from_base64(saved.encrypted_value, sodium.base64_variants.ORIGINAL), keys.publicKey, keys.privateKey);
  assert.equal(sodium.to_string(decrypted), value);
  assert.equal(saved.visibility, 'selected'); assert.deepEqual(saved.selected_repository_ids, [101, 102]);
  assert.equal(result.stored, true); assert.equal(result.launchVerified, false);
});

test('existing secrets are preserved and uncertain uploads do not claim success or retry writes', async () => {
  const existing = createGitHubApi({ credential: () => 'synthetic', fetch: async () => Response.json({ name: 'EXISTING' }) });
  await assert.rejects(uploadGitHubSecret(existing, { kind: 'repository', repository: 'example/project' }, 'EXISTING', 'synthetic-value'), /SECRET_EXISTS/);
  assert.equal(existing.requests, 1);
  await sodium.ready; const keys = sodium.crypto_box_keypair();
  let puts = 0;
  const failed = createGitHubApi({ credential: () => 'synthetic', fetch: async (url, init) => {
    if (String(url).endsWith('/public-key')) return Response.json({ key_id: 'test-key', key: sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL) });
    if (init?.method === 'PUT') { puts++; return new Response(null, { status: 503 }); }
    return new Response(null, { status: 404 });
  } });
  await assert.rejects(uploadGitHubSecret(failed, { kind: 'repository', repository: 'example/project' }, 'NEW_SECRET', 'synthetic-value'), /UNCONFIRMED/);
  assert.equal(puts, 1);
});
