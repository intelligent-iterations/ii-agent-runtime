import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubEvidenceCollector, githubPermissionPreflight } from '../../../src/providers/tools/github-preflight.js';
import { githubContents } from '../../../src/providers/tools/github.js';
import { createGrant, createToolSession, defineTool } from '../../../src/runtime/tools.js';
import { preflightTools } from '../../../src/runtime/preflight.js';

test('GitHub collector pins workflow reads to a commit and never follows caller-controlled download URLs', async () => {
  const calls: string[] = [];
  const sha = 'a'.repeat(40);
  const collector = githubEvidenceCollector({ token: async () => 'test-read-only-key', fetch: async (url, init) => {
    calls.push(String(url));
    assert.equal((init!.headers as any).authorization, 'Bearer test-read-only-key');
    assert.equal(init!.redirect, 'error');
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/actions/permissions')) return Response.json({ enabled: true });
    if (path.includes('/commits/')) return Response.json({ sha });
    if (path.endsWith('/contents/.github/workflows')) return Response.json([
      { type: 'file', path: '.github/workflows/build.yml', download_url: 'https://attacker.invalid/steal' },
    ]);
    return Response.json({ encoding: 'base64', content: Buffer.from('on: push\njobs:\n  build:\n    steps:\n      - run: echo test\n').toString('base64') });
  } });
  const result = await collector('org/repo', 'agent/work', new AbortController().signal);
  assert.equal(result.complete, true);
  assert.equal(result.workflows.length, 1);
  assert.ok(calls.every(url => url.startsWith('https://api.github.com/')));
  assert.ok(calls.filter(url => url.includes('/contents/')).every(url => url.endsWith(`?ref=${sha}`)));
  assert.ok(!JSON.stringify(result).includes('test-read-only-key'));
});

test('GitHub collector distinguishes missing workflows from authorization failures', async () => {
  const collector = githubEvidenceCollector({ token: async () => 'test-key', fetch: async () => new Response('{}', { status: 403 }) });
  await assert.rejects(collector('org/repo', 'main', new AbortController().signal), /evidence unavailable/);
});

for (const fixedContent of [false, true]) test(`literal script control respects fixed content grants (${fixedContent})`, async () => {
  const tool = defineTool({ name: 'write-script', operation: githubContents().write,
    credential: { provider: 'github', resource: 'org/repo', key: 'test', assignment: 'agent:test' } });
  const session = createToolSession({ subject: 'agent:test', tools: [tool],
    grants: [createGrant({ subject: 'agent:test', tool, resources: { repository: ['org/repo'], branch: ['main'], path: ['scripts/build.sh'] },
      ...(fixedContent ? { arguments: { content: [Buffer.from('echo approved').toString('base64')] } } : {}) })],
    context: { executionId: 'test', attemptId: 'test', inputDigest: 'sha256:test', deadlineMs: Date.now() + 30000, signal: new AbortController().signal },
    resolveCredential: async () => { throw Error('not used'); } });
  const report = await preflightTools(session, { signal: new AbortController().signal,
    inspectors: [githubPermissionPreflight(async (repository, branch) => ({ repository, branch, actionsEnabled: true, complete: true,
      source: 'github:test', observedAt: Date.now(), workflows: [{ path: '.github/workflows/deploy.yml', content:
        'on: push\njobs:\n  deploy:\n    permissions:\n      id-token: write\n    steps:\n      - uses: actions/checkout@v4\n      - run: scripts/build.sh\n' }] }))] });
  const check = report.checks.find(item => item.id === 'github.workflow-execution')!;
  assert.equal(check.status, fixedContent ? 'unknown' : 'finding');
  if (!fixedContent) assert.ok(check.summary.startsWith('Potential escalation'));
  else assert.ok(check.limitations.some(item => item.includes('Fixed content grants')));
  assert.equal(check.severity, 'high');
  assert.deepEqual(check.path, fixedContent ? ['org/repo@main:.github/workflows/deploy.yml#deploy']
    : ['contents.write org/repo@main:scripts/build.sh', 'org/repo@main:.github/workflows/deploy.yml#deploy']);
  assert.equal(report.checks.find(item => item.id === 'github.workflow-definition')!.status, 'not-applicable');
});

const jobCases = [
  { name: 'separate job credentials', status: 'unknown', content: `on: push
jobs:
  build:
    permissions: {contents: read}
    steps:
      - uses: actions/checkout@v4
      - run: scripts/build.sh
  deploy:
    permissions: {id-token: write}
    steps:
      - run: echo deploy
` },
  { name: 'job override removes inherited OIDC', status: 'unknown', content: `on: push
permissions: {id-token: write}
jobs:
  build:
    permissions: {contents: read}
    steps:
      - uses: actions/checkout@v4
      - run: scripts/build.sh
` },
  { name: 'workflow OIDC inherited by the same job', status: 'finding', content: `on: push
permissions: {id-token: write}
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - run: scripts/build.sh
` },
  { name: 'comments are not authority', status: 'unknown', content: `on: push
# permissions: write-all; secrets.PRODUCTION
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - run: scripts/build.sh
` },
  ...['ref: stable', 'repository: another/repo', 'path: other'].map(setting => ({ name: `checkout ${setting}`, status: 'unknown', content: `on: push
permissions: {id-token: write}
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with: {${setting}}
      - run: scripts/build.sh
` })),
  { name: 'script before checkout', status: 'unknown', content: `on: push
permissions: {id-token: write}
jobs:
  build:
    steps:
      - run: scripts/build.sh
      - uses: actions/checkout@v4
` },
  { name: 'same-job secret expression', status: 'finding', content: 'on: push\njobs:\n  build:\n    env:\n      TOKEN: ${{ secrets.PRODUCTION }}\n    steps:\n      - uses: actions/checkout@v4\n      - run: scripts/build.sh\n' },
];
// Extensionless programs are common in real workflows (for example `ci/test`, or `./gradlew` in Gradle projects).
const programCases = [
  { run: 'ci/test', path: 'ci/test', status: 'finding' },
  { run: './gradlew build', path: 'gradlew', status: 'finding' },
  { run: 'bash script/build --release', path: 'script/build', status: 'finding' },
  { run: 'RUST_LOG=debug CI=1 ci/test --all', path: 'ci/test', status: 'finding' },
  { run: 'cargo fmt && ci/check', path: 'ci/check', status: 'finding' },
  { run: 'echo ci/test', path: 'ci/test', status: 'unknown' },
  { run: 'cp \\\n  ci/test out/', path: 'ci/test', status: 'unknown' },
  { run: '../ci/test', path: 'ci/test', status: 'unknown' },
  { run: '$TOOLS/ci/test', path: 'ci/test', status: 'unknown' },
];
for (const example of programCases) test(`literal program at command position: ${JSON.stringify(example.run)}`, async () => {
  const subject = 'agent:test';
  const tool = defineTool({ name: 'write-script', operation: githubContents().write,
    credential: { provider: 'github', resource: 'org/repo', key: 'test', assignment: subject } });
  const content = `on: push\npermissions: {id-token: write}\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n      - run: ${JSON.stringify(example.run)}\n`;
  const checks = await githubPermissionPreflight(async (repository, branch) => ({ repository, branch,
    actionsEnabled: true, complete: true, source: 'github:fixture', observedAt: Date.now(),
    workflows: [{ path: '.github/workflows/test.yml', content }] })).inspect({ subject, tools: [tool],
    grants: [createGrant({ subject, tool, resources: { repository: ['org/repo'], branch: ['main'], path: [example.path] } })],
    now: Date.now(), signal: new AbortController().signal });
  assert.equal(checks.find(item => item.id === 'github.workflow-execution')!.status, example.status);
});

for (const example of jobCases) test(`workflow provenance: ${example.name}`, async () => {
  const tool = defineTool({ name: 'write-script', operation: githubContents().write,
    credential: { provider: 'github', resource: 'org/repo', key: 'test', assignment: 'agent:test' } });
  const subject = 'agent:test';
  const checks = await githubPermissionPreflight(async (repository, branch) => ({ repository, branch,
    actionsEnabled: true, complete: true, source: 'github:fixture', observedAt: Date.now(),
    workflows: [{ path: '.github/workflows/test.yml', content: example.content }] })).inspect({ subject, tools: [tool],
    grants: [createGrant({ subject, tool, resources: { repository: ['org/repo'], branch: ['main'], path: ['scripts/build.sh'] } })],
    now: Date.now(), signal: new AbortController().signal });
  assert.equal(checks.find(item => item.id === 'github.workflow-execution')!.status, example.status);
});
