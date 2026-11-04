import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubPermissionPreflight, type GitHubRepositoryEvidence, type WorkflowIdentityAssessor, type WorkflowIdentityRequest } from '../../../src/providers/tools/github-preflight.js';
import { githubContents } from '../../../src/providers/tools/github.js';
import { awsGithubOidcTrust } from '../../../src/providers/tools/aws-role-authority.js';
import { awsWorkflowRoleAssessor } from '../../../src/providers/tools/cloud-evidence.js';
import { createGrant, createToolSession, defineTool } from '../../../src/runtime/tools.js';
import { admitToolSession, preflightTools } from '../../../src/runtime/preflight.js';

const role = 'arn:aws:iam::123456789012:role/app-deploy';
const lambda = 'arn:aws:lambda:us-east-1:123456789012:function:api';
const deploy = (extra = '', run = './scripts/deploy.sh') => `on: push
permissions: {contents: read}
jobs:
  deploy:
    permissions: {id-token: write, contents: read}
${extra}    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${role}
          aws-region: us-east-1
      - run: ${run}
`;
const subject = 'agent:coder';
function session(paths: string[], workflows: string[], options: { identity?: WorkflowIdentityAssessor; actionsEnabled?: boolean; fail?: boolean } = {}) {
  const tool = defineTool({ name: 'write-file', operation: githubContents().write,
    credential: { provider: 'github', resource: 'org/app', key: 'test', assignment: subject } });
  const tools = createToolSession({ subject, tools: [tool],
    grants: [createGrant({ subject, tool, resources: { repository: ['org/app'], branch: ['main'], path: paths } })],
    context: { executionId: 'test', attemptId: 'test', inputDigest: 'sha256:test', deadlineMs: Date.now() + 60000, signal: new AbortController().signal },
    resolveCredential: async () => { throw Error('Preflight must not resolve the agent credential'); } });
  const collect = async (repository: string, branch: string): Promise<GitHubRepositoryEvidence> => {
    if (options.fail) throw Error('GitHub evidence unavailable');
    return { repository, branch, actionsEnabled: options.actionsEnabled ?? true, complete: true, source: 'github:fixture', observedAt: Date.now(),
      workflows: workflows.map((content, index) => ({ path: `.github/workflows/w${index}.yml`, content })) };
  };
  const inspector = githubPermissionPreflight(collect, options.identity ? { workflowIdentity: options.identity } : {});
  return { tools, inspector };
}
async function execution(paths: string[], workflows: string[], options: Parameters<typeof session>[2] = {}) {
  const { tools, inspector } = session(paths, workflows, options);
  const report = await preflightTools(tools, { signal: new AbortController().signal, inspectors: [inspector] });
  return { report, tools, check: report.checks.find(item => item.id === 'github.workflow-execution')! };
}
function assessor(requests: WorkflowIdentityRequest[], trust: 'admits' | 'excludes' | 'unknown' = 'admits'): WorkflowIdentityAssessor {
  return async request => {
    requests.push(request);
    return { identity: request.identity, trust,
      potentialAuthority: [{ provider: 'aws', operation: 'lambda:UpdateFunctionCode', resources: { resource: [lambda] } }],
      declaredAuthority: [{ provider: 'aws', operation: 'lambda:UpdateFunctionCode', resources: { resource: [lambda] } },
        { provider: 'aws', operation: 's3:PutObject', resources: { resource: ['arn:aws:s3:::app-assets/site'] } }],
      evidence: [{ source: 'aws:iam:GetRole', resource: request.identity, observedAt: Date.now() }],
      limitations: ['IAM simulation is not live authorization.'] };
  };
}

test('a writable deploy script joins the workflow job to its assumed role and the role authority', async () => {
  const requests: WorkflowIdentityRequest[] = [];
  const { check, report, tools } = await execution(['scripts/deploy.sh', 'docs/guide.md'], [deploy()], { identity: assessor(requests) });
  assert.equal(check.status, 'finding');
  assert.equal(check.severity, 'high');
  assert.match(check.summary, /^Potential escalation: .*requests arn:aws:iam::123456789012:role\/app-deploy/);
  assert.deepEqual(requests, [{ provider: 'aws', identity: role, region: 'us-east-1', repository: 'org/app', branch: 'main',
    workflow: 'org/app@main:.github/workflows/w0.yml#deploy', oidc: true, oidcSubject: 'repo:org/app:ref:refs/heads/main' }]);
  assert.deepEqual(check.path, [
    'contents.write org/app@main:scripts/deploy.sh',
    'org/app@main:.github/workflows/w0.yml#deploy',
    `assumes aws ${role} in us-east-1 via OIDC`,
    'trust policy admits repo:org/app:ref:refs/heads/main',
    `aws:lambda:UpdateFunctionCode ${lambda} (provider-evaluated allow)`,
    'aws:s3:PutObject arn:aws:s3:::app-assets/site (declared in policy, not provider-evaluated)',
  ]);
  assert.ok(check.evidence.some(item => item.source === 'aws:iam:GetRole' && item.resource === role));
  assert.ok(check.limitations.includes('IAM simulation is not live authorization.'));
  assert.throws(() => admitToolSession(tools, report), /PREFLIGHT_REQUIREMENT_UNMET/);
});

test('a job environment changes the OIDC subject; an expression environment leaves it undetermined', async () => {
  const requests: WorkflowIdentityRequest[] = [];
  await execution(['scripts/deploy.sh'], [deploy('    environment: production\n')], { identity: assessor(requests) });
  assert.equal(requests[0]!.oidcSubject, 'repo:org/app:environment:production');
  await execution(['scripts/deploy.sh'], [deploy('    environment: ${{ inputs.target }}\n')], { identity: assessor(requests) });
  assert.equal(requests[1]!.oidcSubject, undefined);
});

test('trust excluding the job is shown on the path', async () => {
  const { check } = await execution(['scripts/deploy.sh'], [deploy()], { identity: assessor([], 'excludes') });
  assert.equal(check.status, 'finding');
  assert.ok(check.path.includes('trust policy does not admit repo:org/app:ref:refs/heads/main'));
});

test('expression roles stay unresolved and are never passed to the cloud adapter', async () => {
  const requests: WorkflowIdentityRequest[] = [];
  const content = deploy().replace(role, '${{ secrets.DEPLOY_ROLE }}');
  const { check } = await execution(['scripts/deploy.sh'], [content], { identity: assessor(requests) });
  assert.equal(check.status, 'finding');
  assert.equal(requests.length, 0);
  assert.ok(check.path.includes('requests aws credentials from role-to-assume ${{ secrets.DEPLOY_ROLE }} (unresolved)'));
  assert.ok(check.limitations.some(item => item.includes('cannot resolve')));
});

test('missing or failing identity adapters keep the finding and report fixed limitations only', async () => {
  const none = await execution(['scripts/deploy.sh'], [deploy()]);
  assert.equal(none.check.status, 'finding');
  assert.ok(none.check.path.includes('identity authority not assessed'));
  assert.ok(none.check.limitations.some(item => item.startsWith('No workflow identity adapter')));
  const failing = await execution(['scripts/deploy.sh'], [deploy()], { identity: async () => { throw Error('leaked-reader-secret'); } });
  assert.equal(failing.check.status, 'finding');
  assert.ok(failing.check.limitations.includes('The aws identity assessment failed.'));
  assert.ok(!JSON.stringify(failing.report).includes('leaked-reader-secret'));
});

test('recognized package-manager steps make root manifests executed inputs', async () => {
  const { check } = await execution(['package.json'], [deploy('', 'npm ci && ./scripts/deploy.sh')], { identity: assessor([]) });
  assert.equal(check.status, 'finding');
  assert.equal(check.path[0], 'contents.write org/app@main:package.json');
});

test('inert, unreferenced documentation writes are clear and pass admission', async () => {
  const requests: WorkflowIdentityRequest[] = [];
  const { check, report, tools } = await execution(['docs/guide.md'], [deploy(), deploy('', './scripts/publish.sh docs/other.md')], { identity: assessor(requests) });
  assert.equal(check.status, 'clear');
  assert.equal(check.severity, 'info');
  assert.equal(requests.length, 0);
  assert.ok(check.evidence.length > 0);
  assert.ok(check.limitations.some(item => item.startsWith('Clear covers execution of agent-writable files')));
  assert.equal(admitToolSession(tools, report), tools);
});

const unclear: { name: string; paths: string[]; workflows: string[]; reason: RegExp; options?: Parameters<typeof session>[2] }[] = [
  { name: 'source code', paths: ['src/handler.js'], workflows: [deploy()], reason: /src\/handler\.js may be run or loaded/ },
  { name: 'unreferenced manifest', paths: ['package.json'], workflows: [deploy()], reason: /package\.json is a manifest/ },
  { name: 'requirements text file', paths: ['requirements-dev.txt'], workflows: [deploy()], reason: /requirements-dev\.txt is a manifest/ },
  { name: 'tool configuration', paths: ['vite.config.ts'], workflows: [deploy()], reason: /vite\.config\.ts is a manifest/ },
  { name: 'workflow definition', paths: ['.github/workflows/deploy.yml'], workflows: [deploy()], reason: /is a workflow or action definition/ },
  { name: 'local action definition', paths: ['.github/actions/deploy/action.yml'], workflows: [deploy()], reason: /is a workflow or action definition/ },
  { name: 'literal reference', paths: ['docs/guide.md'], workflows: [deploy('', './scripts/publish.sh docs/guide.md')], reason: /docs\/guide\.md is referenced by/ },
  { name: 'directory reference', paths: ['docs/guide.md'], workflows: [deploy('', './scripts/publish.sh docs/')], reason: /is referenced by/ },
  { name: 'extension glob', paths: ['docs/guide.md'], workflows: [deploy('', 'cat **/*.md')], reason: /is referenced by/ },
  { name: 'local action use', paths: ['docs/guide.md'], workflows: [deploy().replace('      - run: ./scripts/deploy.sh\n', '      - uses: ./deploy-action\n')], reason: /unsupported/ },
  { name: 'unparsable workflow', paths: ['docs/guide.md'], workflows: [deploy(), 'jobs: [unclosed'], reason: /unsupported/ },
  { name: 'incomplete evidence', paths: ['docs/guide.md'], workflows: [], reason: /incomplete/, options: { fail: true } },
];
for (const example of unclear) test(`clear is not inferred: ${example.name}`, async () => {
  const { check } = await execution(example.paths, example.workflows, example.options);
  assert.notEqual(check.status, 'clear');
  assert.ok(check.limitations.some(item => example.reason.test(item)), check.limitations.join('\n'));
});

test('definition grants include local actions', async () => {
  const { tools, inspector } = session(['.github/actions/deploy/action.yml'], [deploy()]);
  const report = await preflightTools(tools, { signal: new AbortController().signal, inspectors: [inspector] });
  assert.equal(report.checks.find(item => item.id === 'github.workflow-definition')!.status, 'unknown');
});

test('disabled Actions remains clear without identity assessment', async () => {
  const requests: WorkflowIdentityRequest[] = [];
  const { check } = await execution(['scripts/deploy.sh'], [deploy()], { identity: assessor(requests), actionsEnabled: false });
  assert.equal(check.status, 'clear');
  assert.equal(requests.length, 0);
});

const trustPolicy = (condition: unknown, principal = 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com') =>
  ({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Federated: principal }, Action: 'sts:AssumeRoleWithWebIdentity',
    ...(condition === undefined ? {} : { Condition: condition }) }] });
const main = 'repo:org/app:ref:refs/heads/main';
for (const example of [
  { name: 'exact subject', policy: trustPolicy({ StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': main } }), trust: 'admits' },
  { name: 'other branch', policy: trustPolicy({ StringEquals: { 'token.actions.githubusercontent.com:sub': 'repo:org/app:ref:refs/heads/release' } }), trust: 'excludes' },
  { name: 'wildcard subject', policy: trustPolicy({ StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:org/app:*' } }), trust: 'admits', limit: /wildcard/ },
  { name: 'no subject condition', policy: trustPolicy({ StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' } }), trust: 'admits', limit: /any GitHub repository/ },
  { name: 'audience mismatch', policy: trustPolicy({ StringEquals: { 'token.actions.githubusercontent.com:aud': 'other', 'token.actions.githubusercontent.com:sub': main } }), trust: 'excludes' },
  { name: 'unsupported operator', policy: trustPolicy({ ForAllValues: { 'token.actions.githubusercontent.com:sub': main } }), trust: 'unknown', limit: /not evaluated/ },
  { name: 'unsupported claim', policy: trustPolicy({ StringEquals: { 'token.actions.githubusercontent.com:sub': main, 'token.actions.githubusercontent.com:job_workflow_ref': 'x' } }), trust: 'unknown' },
  { name: 'not a GitHub provider', policy: trustPolicy({ StringEquals: { 'token.actions.githubusercontent.com:sub': main } }, 'arn:aws:iam::123456789012:oidc-provider/example.com'), trust: 'excludes', limit: /No trust statement/ },
  { name: 'encoded document', policy: encodeURIComponent(JSON.stringify(trustPolicy({ StringEquals: { 'token.actions.githubusercontent.com:sub': main } }))), trust: 'admits' },
] as { name: string; policy: unknown; trust: string; limit?: RegExp }[]) test(`GitHub OIDC trust: ${example.name}`, () => {
  const result = awsGithubOidcTrust(example.policy, { subject: main });
  assert.equal(result.trust, example.trust);
  if (example.limit) assert.ok(result.limitations.some(item => example.limit!.test(item)), result.limitations.join('\n'));
});
test('GitHub OIDC trust needs a determinable subject', () => {
  assert.equal(awsGithubOidcTrust(trustPolicy({ StringEquals: { 'token.actions.githubusercontent.com:sub': main } }), {}).trust, 'unknown');
});

test('AWS workflow role assessor reads only the named role through the isolated CLI', async () => {
  const calls: string[][] = [];
  const assess = awsWorkflowRoleAssessor({ command: '/test/aws', cwd: '/tmp', environment: { AWS_ACCESS_KEY_ID: 'reader-id', AWS_SECRET_ACCESS_KEY: 'private-key' },
    process: async request => {
      calls.push(request.args);
      assert.equal(request.env.AWS_CONFIG_FILE, '/dev/null');
      assert.equal(request.env.HOME, undefined);
      assert.deepEqual(request.args.slice(-5), ['--region', 'us-east-1', '--output', 'json', '--no-cli-pager']);
      switch (request.args[1]) {
        case 'get-role': return JSON.stringify({ Role: { Arn: role, AssumeRolePolicyDocument: trustPolicy({ StringEquals: { 'token.actions.githubusercontent.com:sub': main } }) } });
        case 'list-role-policies': return JSON.stringify({ PolicyNames: ['deploy'] });
        case 'get-role-policy': return JSON.stringify({ PolicyDocument: { Statement: [{ Effect: 'Allow', Action: 'lambda:UpdateFunctionCode', Resource: lambda }] } });
        case 'list-attached-role-policies': return JSON.stringify({ AttachedPolicies: [] });
        case 'simulate-principal-policy': return JSON.stringify({ EvaluationResults: [{ EvalActionName: 'lambda:UpdateFunctionCode', EvalResourceName: lambda,
          EvalDecision: 'allowed', MissingContextValues: [] }] });
        default: throw Error('Unexpected read');
      }
    } });
  const result = await assess({ provider: 'aws', identity: role, repository: 'org/app', branch: 'main', workflow: 'w', oidc: true, oidcSubject: main }, new AbortController().signal);
  assert.equal(result.trust, 'admits');
  assert.deepEqual(result.potentialAuthority, [{ provider: 'aws', operation: 'lambda:UpdateFunctionCode', resources: { resource: [lambda] } }]);
  assert.deepEqual(result.declaredAuthority, result.potentialAuthority);
  assert.deepEqual(calls[0]!.slice(0, 4), ['iam', 'get-role', '--role-name', 'app-deploy']);
  assert.ok(calls.every(args => args[0] === 'iam'));
  assert.ok(result.evidence.some(item => item.source === 'aws:iam:GetRole'));
  assert.ok(!JSON.stringify(result).includes('private-key'));
  await assert.rejects(assess({ provider: 'aws', identity: 'app-deploy', repository: 'org/app', branch: 'main', workflow: 'w', oidc: true }, new AbortController().signal), /Unsupported/);
  await assert.rejects(assess({ provider: 'gcp', identity: role, repository: 'org/app', branch: 'main', workflow: 'w', oidc: true }, new AbortController().signal), /Unsupported/);
});

test('AWS workflow role assessor keeps read failures and stored-key trust unknown', async () => {
  const failing = awsWorkflowRoleAssessor({ command: '/test/aws', cwd: '/tmp', environment: {},
    process: async () => { throw Error('AccessDenied for private-key'); } });
  const failed = await failing({ provider: 'aws', identity: role, repository: 'org/app', branch: 'main', workflow: 'w', oidc: true, oidcSubject: main }, new AbortController().signal);
  assert.equal(failed.trust, 'unknown');
  assert.deepEqual(failed.potentialAuthority, []);
  assert.ok(!JSON.stringify(failed).includes('private-key'));
  const keys = awsWorkflowRoleAssessor({ command: '/test/aws', cwd: '/tmp', environment: {},
    process: async request => request.args[1] === 'get-role' ? JSON.stringify({ Role: { Arn: role, AssumeRolePolicyDocument: trustPolicy(undefined) } })
      : JSON.stringify({ PolicyNames: [], AttachedPolicies: [] }) });
  const stored = await keys({ provider: 'aws', identity: role, repository: 'org/app', branch: 'main', workflow: 'w', oidc: false }, new AbortController().signal);
  assert.equal(stored.trust, 'unknown');
  assert.ok(stored.limitations.some(item => item.includes('stored keys')));
  assert.throws(() => awsWorkflowRoleAssessor({ command: 'aws', cwd: '/tmp', environment: {} }), /explicit executable/);
});
