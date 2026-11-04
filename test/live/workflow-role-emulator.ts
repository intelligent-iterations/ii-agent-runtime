import assert from 'node:assert/strict';
import { awsWorkflowRoleAssessor } from '../../src/providers/tools/cloud-evidence.js';
import { githubPermissionPreflight } from '../../src/providers/tools/github-preflight.js';
import { githubContents } from '../../src/providers/tools/github.js';
import { createGrant, createToolSession, defineTool } from '../../src/runtime/tools.js';
import { admitToolSession, preflightTools } from '../../src/runtime/preflight.js';
import { runTrustedProcess } from '../../src/providers/shared/process.js';

// Seeded by workflow-role-emulator.py through the emulator's IAM API.
const [endpoint, role, missingRole, cli] = process.argv.slice(2);
assert.match(endpoint!, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
const workflow = (identity: string) => `on: push
permissions: {contents: read}
jobs:
  deploy:
    permissions: {id-token: write, contents: read}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${identity}
          aws-region: us-east-1
      - run: ./scripts/deploy.sh
`;
let cliCalls = 0;
// Production assessor; only the transport destination is overridden to the owned emulator.
const assessor = awsWorkflowRoleAssessor({ command: cli!, cwd: process.cwd(),
  environment: { AWS_ACCESS_KEY_ID: 'testing', AWS_SECRET_ACCESS_KEY: 'testing' },
  process: request => { cliCalls++; return runTrustedProcess({ ...request, args: [...request.args, '--endpoint-url', endpoint!] }); } });
async function run(path: string, branch: string, identity = role!) {
  const subject = 'agent:emulator';
  const tool = defineTool({ name: 'write-file', operation: githubContents().write,
    credential: { provider: 'github', resource: 'org/app', key: 'synthetic', assignment: subject } });
  const session = createToolSession({ subject, tools: [tool],
    grants: [createGrant({ subject, tool, resources: { repository: ['org/app'], branch: [branch], path: [path] } })],
    context: { executionId: 'emulator', attemptId: 'one', inputDigest: 'emulator', deadlineMs: Date.now() + 60000, signal: AbortSignal.timeout(60000) },
    resolveCredential: async () => { throw Error('No backing credential may be resolved'); } });
  const before = cliCalls;
  const report = await preflightTools(session, { signal: AbortSignal.timeout(60000), timeoutMs: 60000, inspectors: [githubPermissionPreflight(
    async (repository, ref) => ({ repository, branch: ref, actionsEnabled: true, complete: true, source: 'github:recorded-fixture',
      observedAt: Date.now(), workflows: [{ path: '.github/workflows/deploy.yml', content: workflow(identity) }] }),
    { workflowIdentity: assessor })] });
  const check = report.checks.find(item => item.id === 'github.workflow-execution')!;
  return { session, report, check, awsCalls: cliCalls - before };
}

const broad = await run('scripts/deploy.sh', 'main');
assert.equal(broad.check.status, 'finding');
assert.ok(broad.check.path.includes(`assumes aws ${role} in us-east-1 via OIDC`));
assert.ok(broad.check.path.includes('trust policy admits repo:org/app:ref:refs/heads/main'));
const declared = broad.check.path.filter(step => step.endsWith('(declared in policy, not provider-evaluated)'));
assert.ok(declared.length >= 3, 'Inline and attached policy statements must be read from the emulator');
const sources = new Set(broad.check.evidence.map(item => item.source));
for (const source of ['aws:iam:GetRole', 'aws:iam:GetRolePolicy', 'aws:iam:GetPolicyVersion']) assert.ok(sources.has(source), source);
const simulationUnavailable = broad.check.limitations.includes('IAM simulation unavailable for a candidate permission.');
assert.ok(simulationUnavailable, 'Moto does not implement principal-policy simulation; this must remain explicit');
assert.throws(() => admitToolSession(broad.session, broad.report), /PREFLIGHT_REQUIREMENT_UNMET/);

const otherBranch = await run('scripts/deploy.sh', 'feature');
assert.ok(otherBranch.check.path.includes('trust policy does not admit repo:org/app:ref:refs/heads/feature'));
const missing = await run('scripts/deploy.sh', 'main', missingRole!);
assert.equal(missing.check.status, 'finding');
assert.ok(missing.check.limitations.includes('The role could not be read; its trust and authority are unverified.'));
assert.ok(!missing.check.evidence.some(item => item.source.startsWith('aws:')));

const source = await run('src/handler.js', 'main');
assert.equal(source.check.status, 'unknown');
assert.ok(source.check.path.includes('trust policy admits repo:org/app:ref:refs/heads/main'));

const restricted = await run('docs/guide.md', 'main');
assert.equal(restricted.check.status, 'clear');
assert.equal(restricted.awsCalls, 0);
assert.equal(admitToolSession(restricted.session, restricted.report), restricted.session);

process.stdout.write(JSON.stringify({ broad: { status: broad.check.status, path: broad.check.path, awsReads: broad.awsCalls },
  otherBranchTrustExcluded: true, missingRoleNegativeControl: true, simulationUnavailable,
  sourceWrite: source.check.status, restricted: { status: restricted.check.status, awsReads: restricted.awsCalls, admitted: true },
  iamProof: false }) + '\n');
