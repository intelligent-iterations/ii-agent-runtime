import { isAbsolute } from 'node:path';
import { runTrustedProcess, type ProcessRunner } from '../shared/process.js';
import type { PreflightEvidence, PreflightInput } from '../../runtime/preflight.js';
import type { ToolConstraints, ToolGrant } from '../../runtime/tools.js';
import type { AuthorityInventory, AuthorityResource } from './preflight.js';
import { readProviderJson } from './http.js';
import { awsGithubOidcTrust, awsRoleAuthority } from './aws-role-authority.js';
import type { WorkflowIdentityAssessment, WorkflowIdentityAssessor } from './github-preflight.js';
import { gcpInstanceAuthority, gcpTroubleshooterUrl } from './gcp-instance-authority.js';
import { gcpGithubWorkloadIdentityTrust, gcpServiceAccountAuthority, gcpServiceAccountProject } from './gcp-service-account-authority.js';
import { azureVmAuthority } from './azure-vm-authority.js';

export interface CloudEvidenceOptions {
  /** A trusted read credential. Never taken from agent arguments or returned in evidence. */
  token(): Promise<string>;
  fetch?: typeof fetch;
}
const MAX_RESOURCES = 64;
const segment = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;
function grants(input: PreflightInput, provider: string, operations: readonly string[]): ToolGrant[] {
  return input.grants.filter(grant => grant.subject === input.subject && input.tools.some(tool => tool.name === grant.tool && tool.provider === provider && operations.includes(tool.operation)));
}
function inventory(provider: string): AuthorityInventory {
  return { provider, evidence: [], resources: [], complete: false,
    limitations: ['Collected execution identities do not establish their effective IAM authority or all execution protections.'] };
}
/** Enumerate exact finite grant scopes, with a cap before making network requests. */
function scopes(grant: ToolGrant, fields: readonly string[]): Record<string, string>[] {
  let result: Record<string, string>[] = [{}];
  for (const field of fields) {
    const values = grant.resources[field];
    if (!values?.length || values.some(value => typeof value !== 'string') || result.length * values.length > MAX_RESOURCES) return [];
    result = result.flatMap(item => values.map(value => ({ ...item, [field]: String(value) })));
  }
  return result;
}
function finiteScope(input: Record<string, string>): ToolConstraints {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, [value]]));
}
async function read(options: CloudEvidenceOptions, url: URL, signal: AbortSignal, body?: unknown): Promise<any> {
  if (signal.aborted) throw Error('Evidence collection interrupted');
  const token = await options.token();
  if (!token) throw Error('Evidence credential unavailable');
  const response = await (options.fetch ?? fetch)(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) { await response.body?.cancel(); throw Error('Cloud evidence unavailable'); }
  return readProviderJson(response);
}

/** Reads only exact Compute instances implicated by startup-code grants, never a project-wide inventory. */
export function gcpEvidenceCollector(options: CloudEvidenceOptions) {
  return async (input: PreflightInput): Promise<AuthorityInventory> => {
    const result = inventory('gcp');
    const resources: AuthorityResource[] = []; const evidence = [];
    let evaluations = 0;
    const seen = new Set<string>();
    for (const grant of grants(input, 'gcp', ['compute.instances.setMetadata', 'compute.instances.reset', 'compute.instances.start'])) {
      for (const scope of scopes(grant, ['project', 'zone', 'instance'])) {
        if (!Object.values(scope).every(value => segment.test(value))) continue;
        const url = new URL(`/compute/v1/projects/${scope.project}/zones/${scope.zone}/instances/${scope.instance}`, 'https://compute.googleapis.com');
        if (seen.has(url.href)) continue;
        if (seen.size >= MAX_RESOURCES) break;
        seen.add(url.href);
        try {
          const value = await read(options, url, input.signal);
          if (value.name !== scope.instance || value.zone !== `https://www.googleapis.com/compute/v1/projects/${scope.project}/zones/${scope.zone}` &&
              value.zone !== `https://compute.googleapis.com/compute/v1/projects/${scope.project}/zones/${scope.zone}` ||
              !Array.isArray(value.serviceAccounts)) continue;
          evidence.push({ source: url.href, resource: `projects/${scope.project}/zones/${scope.zone}/instances/${scope.instance}`, observedAt: Date.now() });
          for (const account of value.serviceAccounts) {
            if (typeof account.email !== 'string' || !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/.test(account.email)) continue;
            const authority = await gcpInstanceAuthority(account.email, scope, body => {
              if (evaluations++ >= 64 || input.signal.aborted) throw Error('GCP authority collection limit reached');
              return read(options, new URL(gcpTroubleshooterUrl), input.signal, body);
            });
            evidence.push(...authority.evidence);
            resources.push({ scope: finiteScope(scope), executionIdentity: account.email,
              potentialAuthority: authority.potentialAuthority, limitations: authority.limitations });
          }
        } catch { /* Missing visibility remains unknown; never retain raw API errors. */ }
      }
    }
    return { ...result, resources, evidence };
  };
}

const azureVm = /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[a-zA-Z0-9._()-]+\/providers\/Microsoft\.Compute\/virtualMachines\/[a-zA-Z0-9._-]+$/;
/** Reads identity metadata on explicitly granted VMs. No subscription enumeration or credential minting. */
export function azureEvidenceCollector(options: CloudEvidenceOptions) {
  return async (input: PreflightInput): Promise<AuthorityInventory> => {
    const result = inventory('azure');
    const resources: AuthorityResource[] = []; const evidence = [];
    let authorityReads = 0;
    const seen = new Set<string>();
    for (const grant of grants(input, 'azure', ['Microsoft.Compute/virtualMachines/runCommand/action',
      'Microsoft.Compute/virtualMachines/extensions/write', 'Microsoft.Compute/virtualMachines/write'])) {
      const field = grant.resources.resourceId ? 'resourceId' : 'resource';
      for (const scope of scopes(grant, [field])) {
        const id = scope[field]!;
        if (!azureVm.test(id) || seen.has(id.toLowerCase())) continue;
        if (seen.size >= MAX_RESOURCES) break;
        seen.add(id.toLowerCase());
        const url = new URL(id, 'https://management.azure.com');
        url.searchParams.set('api-version', '2024-11-01');
        try {
          const value = await read(options, url, input.signal);
          if (typeof value.id !== 'string' || value.id.toLowerCase() !== id.toLowerCase()) continue;
          evidence.push({ source: url.href, resource: id, observedAt: Date.now() });
          const identities = [value.identity?.principalId,
            ...Object.values(value.identity?.userAssignedIdentities ?? {}).map((item: any) => item?.principalId)];
          for (const principal of identities) if (typeof principal === 'string' && /^[0-9a-fA-F-]{36}$/.test(principal)) {
            const authority = await azureVmAuthority(principal, id, field, target => {
              if (authorityReads++ >= 64 || input.signal.aborted) throw Error('Azure authority collection limit reached');
              return read(options, target, input.signal);
            });
            evidence.push(...authority.evidence);
            resources.push({ scope: finiteScope(scope), executionIdentity: principal,
              potentialAuthority: authority.potentialAuthority, limitations: authority.limitations });
          }
        } catch { /* Keep missing or malformed provider evidence unknown. */ }
      }
    }
    return { ...result, resources, evidence };
  };
}

interface AwsCliOptions {
  command: string; cwd: string; environment: Readonly<Record<string, string>>; process?: ProcessRunner;
}
/** The operator's explicitly selected AWS CLI with ambient configuration disabled. */
function awsCli(options: AwsCliOptions) {
  if (!isAbsolute(options.command) || !isAbsolute(options.cwd)) throw Error('AWS evidence requires explicit executable and working-directory paths');
  const allowed = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']);
  if (Object.keys(options.environment).some(key => !allowed.has(key))) throw Error('Unsupported AWS evidence environment');
  const env = { ...options.environment, AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '1', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off',
    AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' };
  const run = options.process ?? runTrustedProcess;
  return {
    run: (args: string[], signal: AbortSignal, timeoutMs: number) => run({ command: options.command, cwd: options.cwd, env, signal,
      timeoutMs, maxOutputBytes: 1048576, args }),
    /** Bounded IAM reads for one assessment. */
    iam(signal: AbortSignal, limit = 64) {
      let reads = 0;
      return async (args: string[]) => {
        if (signal.aborted || reads++ >= limit) throw Error('AWS authority collection limit reached');
        return JSON.parse(await this.run([...args, '--region', 'us-east-1', '--output', 'json', '--no-cli-pager'], signal, 10000));
      };
    },
  };
}

/** Uses the operator's explicitly selected AWS CLI; only a fixed read command is issued. */
export function awsEvidenceCollector(options: AwsCliOptions) {
  const cli = awsCli(options);
  return async (input: PreflightInput): Promise<AuthorityInventory> => {
    const result = inventory('aws');
    const resources: AuthorityResource[] = []; const evidence = [];
    const roles = new Map<string, Awaited<ReturnType<typeof awsRoleAuthority>>>();
    const readPolicy = cli.iam(input.signal);
    const seen = new Set<string>();
    for (const grant of grants(input, 'aws', ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'])) {
      const field = grant.resources.functionArn ? 'functionArn' : 'resource';
      for (const scope of scopes(grant, [field])) {
        const arn = scope[field]!;
        const match = /^arn:aws:lambda:([a-z]{2}-[a-z]+-[0-9]):([0-9]{12}):function:([a-zA-Z0-9_-]{1,64})$/.exec(arn);
        if (!match || seen.has(arn)) continue;
        if (seen.size >= MAX_RESOURCES) break;
        seen.add(arn);
        try {
          const output = await cli.run(['lambda', 'get-function-configuration', '--function-name', arn, '--region', match[1]!,
            '--query', '{FunctionArn:FunctionArn,Role:Role}', '--output', 'json', '--no-cli-pager'], input.signal, 30000);
          const value = JSON.parse(output);
          if (value.FunctionArn !== arn || typeof value.Role !== 'string' || !/^arn:aws:iam::[0-9]{12}:role\/[a-zA-Z0-9+=,.@_/-]+$/.test(value.Role)) continue;
          evidence.push({ source: 'aws:lambda:GetFunctionConfiguration', resource: arn, observedAt: Date.now() });
          if (!roles.has(value.Role)) roles.set(value.Role, await awsRoleAuthority(value.Role, readPolicy));
          const authority = roles.get(value.Role)!;
          evidence.push(...authority.evidence);
          resources.push({ scope: finiteScope(scope), executionIdentity: value.Role,
            potentialAuthority: authority.potentialAuthority, limitations: authority.limitations });
        } catch { /* Raw CLI output/errors can contain secrets and never enter the report. */ }
      }
    }
    return { ...result, resources, evidence };
  };
}

/** Assesses an IAM role that a workflow job names explicitly: its GitHub OIDC trust and its policies.
 * Reads only that role; it never enumerates the account or the backing reader credential.
 */
export function awsWorkflowRoleAssessor(options: AwsCliOptions): WorkflowIdentityAssessor {
  const cli = awsCli(options);
  return async (request, signal): Promise<WorkflowIdentityAssessment> => {
    if (request.provider !== 'aws' || !/^arn:aws:iam::[0-9]{12}:role\/[a-zA-Z0-9+=,.@_/-]{1,512}$/.test(request.identity)) throw Error('Unsupported workflow identity');
    const read = cli.iam(signal);
    const evidence = [];
    const limitations: string[] = [];
    let trust: WorkflowIdentityAssessment['trust'] = 'unknown';
    try {
      const value = await read(['iam', 'get-role', '--role-name', request.identity.split('/').at(-1)!]);
      if (value.Role?.Arn !== request.identity) throw Error('Mismatched role');
      evidence.push({ source: 'aws:iam:GetRole', resource: request.identity, observedAt: Date.now() });
      if (request.oidc) {
        const assessed = awsGithubOidcTrust(value.Role.AssumeRolePolicyDocument, request.oidcSubject ? { subject: request.oidcSubject } : {});
        trust = assessed.trust;
        limitations.push(...assessed.limitations);
      } else limitations.push('The job assumes the role with stored keys; the trusted AWS principals are not evaluated.');
    } catch {
      return { identity: request.identity, trust, potentialAuthority: [], declaredAuthority: [], evidence,
        limitations: ['The role could not be read; its trust and authority are unverified.'] };
    }
    const authority = await awsRoleAuthority(request.identity, read);
    return { identity: request.identity, trust, potentialAuthority: authority.potentialAuthority, declaredAuthority: authority.declaredAuthority,
      evidence: [...evidence, ...authority.evidence],
      limitations: [...new Set([...limitations, ...authority.limitations, 'Assumes GitHub\'s default OIDC subject format; subject-claim customizations are not read.'])] };
  };
}

const gcpServiceAccountEmail = /^[a-z0-9][a-z0-9._-]{0,99}@[a-z0-9][a-z0-9.-]{0,99}\.gserviceaccount\.com$/;
const gcpProject = /^[a-z0-9][a-z0-9-]{3,62}$/;
/** Assesses a GCP service account that a workflow job names explicitly: whether its IAM bindings admit the
 * job's GitHub OIDC token, the roles bound to it on its home project (and any explicitly named projects), and
 * Policy Troubleshooter results for fixed high-impact permissions. Reads only those policies; it never lists
 * projects, other principals or the reader credential's own authority.
 */
export function gcpWorkflowServiceAccountAssessor(options: CloudEvidenceOptions & {
  /** Additional projects whose bindings for the account are read, for accounts used outside their home project. */
  projects?: readonly string[];
}): WorkflowIdentityAssessor {
  return async (request, signal): Promise<WorkflowIdentityAssessment> => {
    if (request.provider !== 'gcp' || !gcpServiceAccountEmail.test(request.identity)) throw Error('Unsupported workflow identity');
    let reads = 0;
    const bounded = (url: URL, body: unknown) => {
      if (signal.aborted || reads++ >= 64) throw Error('GCP authority collection limit reached');
      return read(options, url, signal, body);
    };
    const home = gcpServiceAccountProject(request.identity);
    const projects = [...new Set([...(home ? [home] : []), ...(options.projects ?? [])])].filter(project => gcpProject.test(project));
    const evidence: PreflightEvidence[] = [];
    const limitations: string[] = home ? [] : ['The service account\'s home project cannot be derived from its email; its project bindings are not read.'];
    let accountBindings: unknown[] | undefined;
    try {
      const url = new URL(`/v1/projects/-/serviceAccounts/${request.identity}:getIamPolicy`, 'https://iam.googleapis.com');
      const policy = await bounded(url, { options: { requestedPolicyVersion: 3 } });
      if (policy.bindings !== undefined && !Array.isArray(policy.bindings)) throw Error('Invalid policy');
      accountBindings = policy.bindings ?? [];
      evidence.push({ source: url.href, resource: request.identity, observedAt: Date.now() });
    } catch { limitations.push('The service account\'s IAM policy could not be read; who may impersonate it is unverified.'); }
    const authority = await gcpServiceAccountAuthority(request.identity, projects,
      project => bounded(new URL(`/v1/projects/${project}:getIamPolicy`, 'https://cloudresourcemanager.googleapis.com'), { options: { requestedPolicyVersion: 3 } }),
      body => bounded(new URL(gcpTroubleshooterUrl), body));
    let trust: WorkflowIdentityAssessment['trust'] = 'unknown';
    if (!request.oidc) limitations.push('The job uses a stored key; workload identity bindings do not apply.');
    else if (accountBindings) {
      // Project-level token-minting bindings on the home project apply to every account in it.
      const assessed = gcpGithubWorkloadIdentityTrust([...accountBindings, ...(home ? authority.bindings.get(home) ?? [] : [])],
        { repository: request.repository, ...(request.oidcSubject ? { subject: request.oidcSubject } : {}),
          ...(request.federation ? { federation: request.federation } : {}) });
      trust = assessed.trust;
      limitations.push(...assessed.limitations);
    }
    return { identity: request.identity, trust, potentialAuthority: authority.potentialAuthority, declaredAuthority: authority.declaredAuthority,
      evidence: [...evidence, ...authority.evidence], limitations: [...new Set([...limitations, ...authority.limitations])] };
  };
}
