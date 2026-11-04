import { resolveWorkflowValue, type WorkflowValueContext } from './workflow-values.js';

/** A cloud identity a workflow step requests, as far as the workflow itself establishes it. */
export interface WorkflowIdentityReference {
  provider: 'aws' | 'gcp';
  /** Resolved identity: an IAM role ARN or a service account email. */
  identity?: string;
  /** Why the identity is not resolved, naming the source value. */
  unresolved?: string;
  region?: string;
  /** Identity federation resource the job's OIDC token is exchanged with, when resolved. */
  federation?: string;
  /** True when the job obtains the identity with its OIDC token rather than stored keys. */
  oidc: boolean;
  /** Source of a long-lived stored key, such as `secrets.GCP_SA_KEY`. */
  staticKey?: string;
  /** Number of possible identities this setting resolves to on the branch, when more than one. */
  alternatives?: number;
}

const roleArn = /^arn:aws:iam::[0-9]{12}:role\/[a-zA-Z0-9+=,.@_/-]{1,512}$/;
const serviceAccount = /^[a-z0-9][a-z0-9._-]{0,99}@[a-z0-9][a-z0-9.-]{0,99}\.gserviceaccount\.com$/;
const workloadIdentityProvider = /^projects\/[0-9]{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const shown = (value: unknown) => typeof value === 'string' ? value.slice(0, 120) : 'a non-string value';

/** Where a stored key comes from, without its value: `secrets.NAME` or a generic description. */
function keySource(value: unknown): string {
  const secret = typeof value === 'string' ? /^\s*\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(value) : null;
  return secret ? `secrets.${secret[1]}` : 'a workflow value';
}
/** One value of a setting, when the branch determines exactly one. */
function single(value: unknown, context: WorkflowValueContext): string | undefined {
  const resolved = resolveWorkflowValue(value, context);
  return 'values' in resolved && resolved.values.length === 1 && resolved.values[0] ? resolved.values[0] : undefined;
}
/** Every identity a setting can name on the branch, or why it cannot be resolved. */
function identities(setting: string, value: unknown, pattern: RegExp, context: WorkflowValueContext): { identities: string[] } | { unresolved: string } {
  const resolved = resolveWorkflowValue(value, context);
  // Name the root source when the value comes through env, such as env.X from vars.X.
  const source = 'unresolved' in resolved ? / from (.+)$/.exec(resolved.unresolved)?.[1] : undefined;
  if ('unresolved' in resolved) return { unresolved: `${setting} ${shown(value)}${source ? `, which comes from ${source}` : ''}` };
  const valid = resolved.values.filter(item => pattern.test(item));
  return valid.length === resolved.values.length ? { identities: valid } : { unresolved: `${setting} ${shown(value)}` };
}

function aws(options: Record<string, any>, context: WorkflowValueContext): WorkflowIdentityReference[] {
  const oidc = options['aws-access-key-id'] === undefined && options['web-identity-token-file'] === undefined;
  const region = single(options['aws-region'], context);
  const base = { provider: 'aws' as const, oidc, ...(region ? { region } : {}) };
  if (options['role-to-assume'] === undefined) return [{ ...base, unresolved: 'stored access keys without role-to-assume',
    ...(options['aws-access-key-id'] !== undefined ? { staticKey: keySource(options['aws-access-key-id']) } : {}) }];
  const roles = identities('role-to-assume', options['role-to-assume'], roleArn, context);
  if ('unresolved' in roles) return [{ ...base, unresolved: roles.unresolved }];
  return roles.identities.map(identity => ({ ...base, identity, ...(roles.identities.length > 1 ? { alternatives: roles.identities.length } : {}) }));
}

function gcp(options: Record<string, any>, context: WorkflowValueContext): WorkflowIdentityReference[] {
  if (options.credentials_json !== undefined) {
    const source = keySource(options.credentials_json);
    return [{ provider: 'gcp', oidc: false, staticKey: source, unresolved: `a service-account key from ${source}` }];
  }
  if (options.workload_identity_provider === undefined)
    return [{ provider: 'gcp', oidc: false, unresolved: 'neither credentials_json nor workload_identity_provider' }];
  const federation = single(options.workload_identity_provider, context);
  const base = { provider: 'gcp' as const, oidc: true,
    ...(federation && workloadIdentityProvider.test(federation) ? { federation } : {}) };
  // Direct federation: the job's token is the principal; there is no service account to read.
  if (options.service_account === undefined)
    return [{ ...base, unresolved: 'direct workload identity federation without a service account' }];
  const accounts = identities('service_account', options.service_account, serviceAccount, context);
  if ('unresolved' in accounts) return [{ ...base, unresolved: accounts.unresolved }];
  return accounts.identities.map(identity => ({ ...base, identity, ...(accounts.identities.length > 1 ? { alternatives: accounts.identities.length } : {}) }));
}

/** Cloud identities requested by one workflow step, from recognized credential actions only. */
export function stepIdentities(step: Record<string, any>, context: WorkflowValueContext): WorkflowIdentityReference[] {
  if (typeof step.uses !== 'string') return [];
  const options = record(step.with) ? step.with : {};
  if (/^aws-actions\/configure-aws-credentials@/.test(step.uses)) return aws(options, context);
  if (/^google-github-actions\/auth@/.test(step.uses)) return gcp(options, context);
  // Legacy setup-gcloud versions accepted a stored key directly.
  if (/^google-github-actions\/setup-gcloud@/.test(step.uses) && options.service_account_key !== undefined) {
    const source = keySource(options.service_account_key);
    return [{ provider: 'gcp', oidc: false, staticKey: source, unresolved: `a service-account key from ${source}` }];
  }
  return [];
}
