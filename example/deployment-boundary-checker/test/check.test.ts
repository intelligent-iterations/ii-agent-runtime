import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGrant, defineTool } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { githubContents } from '@intelligent-iterations/ii-agent-runtime/tools';
import { checkBoundary, checkGcpTokenFile, checkoutOf, gcpServiceAccounts, githubWorkflows, loadAgent, localWorkflows, requireWorkflowFiles,
  singleScope, type AgentGrants } from '../src/check.js';
import { renderComparison, renderResult } from '../src/render.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflows = join(root, 'fixtures/functions/workflows');
const prod = 'deployer@acme-functions-prod.iam.gserviceaccount.com';
const dev = 'deployer@acme-functions-dev.iam.gserviceaccount.com';
const pool = 'projects/123456789/locations/global/workloadIdentityPools/github';
const assumesProd = `assumes gcp ${prod} via OIDC through ${pool}/providers/github`;

/** Recorded GCP response shapes, replayed through the production service-account adapter. */
function recordedGcp(calls: string[] = []): typeof fetch {
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    calls.push(target.href);
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer reader-token-from-file');
    if (target.hostname === 'iam.googleapis.com') return Response.json({ bindings: [{ role: 'roles/iam.workloadIdentityUser',
      members: [`principalSet://iam.googleapis.com/${pool}/attribute.repository/acme/functions`] }] });
    if (target.hostname === 'cloudresourcemanager.googleapis.com') {
      const project = /projects\/([^:]+):getIamPolicy/.exec(target.pathname)![1];
      return Response.json({ bindings: [{ role: 'roles/cloudfunctions.developer', members: [`serviceAccount:deployer@${project}.iam.gserviceaccount.com`] }] });
    }
    const body = JSON.parse(String(init?.body));
    return Response.json({ accessTuple: body.accessTuple, overallAccessState: 'CANNOT_ACCESS' });
  };
}
/** A designated GCP reader whose token file lives in a temporary directory. */
function withGcpReader<T>(use: (tokenFile: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'boundary-gcp-'));
  const tokenFile = join(directory, 'token');
  writeFileSync(tokenFile, 'reader-token-from-file\n');
  return use(tokenFile).finally(() => rmSync(directory, { recursive: true, force: true }));
}
function writer(paths: string[], repository = 'acme/functions'): AgentGrants {
  const subject = 'agent:test';
  const tool = defineTool({ name: 'write-file', operation: githubContents().write,
    credential: { provider: 'github', resource: repository, key: 'test', assignment: subject } });
  return { subject, tools: [tool], grants: [createGrant({ subject, tool, resources: { repository: [repository], branch: ['main'], path: paths } })] };
}
const check = (agent: AgentGrants, options: { directory?: string; workflowIdentity?: Parameters<typeof checkBoundary>[0]['workflowIdentity'] } = {}) =>
  checkBoundary({ agent, workflows: localWorkflows(options.directory ?? workflows, singleScope(agent)),
    ...(options.workflowIdentity ? { workflowIdentity: options.workflowIdentity } : {}) });
/** A temporary workflow directory holding the given files. */
async function inDirectory<T>(files: Record<string, string>, use: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'boundary-workflows-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
    return await use(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('broad sample: each deploy job its files reach is a path to every service account a run on main can use, and to a stored key', async () => {
  const result = await check(await loadAgent(join(root, 'agents/broad.ts')));
  assert.equal(result.answer, 'yes');
  assert.equal(result.admission, 'blocked');
  for (const step of [assumesProd, `assumes gcp ${dev} via OIDC through ${pool}/providers/github`,
    'uses a long-lived gcp key from secrets.HOSTING_SA_KEY (identity unresolved)']) assert.ok(result.execution.path.includes(step), step);
  assert.ok(result.execution.limitations.some(item => item.includes('can request 2 gcp identities on refs/heads/main')));
  assert.ok(result.execution.limitations.some(item => item.includes('long-lived gcp key from secrets.HOSTING_SA_KEY')));
  const text = renderResult(result);
  assert.match(text, /YES: a workflow job with deployment credentials runs a file this agent can write/);
  assert.match(text, /gcp authority not assessed \(no credential designated\)/);
  // Each job the agent's files reach is its own numbered path.
  assert.match(text, /Path 1:\n  1\. contents\.write acme\/functions@main:scripts\/deploy-functions\.sh\n  2\. contents\.write acme\/functions@main:package\.json\n  3\. acme\/functions@main:\.github\/workflows\/deploy\.yml#functions\n/);
  assert.match(text, /Path 2:\n  1\. contents\.write acme\/functions@main:package\.json\n  2\. acme\/functions@main:\.github\/workflows\/deploy\.yml#hosting\n  3\. uses a long-lived gcp key/);
  assert.match(text, /Cloud identities these jobs use:\n  gcp deployer@acme-functions-prod\.iam\.gserviceaccount\.com\n  gcp deployer@acme-functions-dev\.iam\.gserviceaccount\.com\n  gcp key from secrets\.HOSTING_SA_KEY/);
});

test('restricted sample: documentation is clear, admitted, and needs no GCP reads', () => withGcpReader(async tokenFile => {
  const calls: string[] = [];
  const result = await check(await loadAgent(join(root, 'agents/restricted.ts')),
    { workflowIdentity: { gcp: gcpServiceAccounts(tokenFile, new Set(), recordedGcp(calls)) } });
  assert.equal(result.execution.status, 'clear');
  assert.equal(result.answer, 'no');
  assert.equal(result.admission, 'admitted');
  assert.equal(calls.length, 0);
}));

test('a designated GCP reader assesses bindings and bound roles; the token never appears', () => withGcpReader(async tokenFile => {
  const result = await check(writer(['scripts/deploy-functions.sh']), { workflowIdentity: { gcp: gcpServiceAccounts(tokenFile, new Set(), recordedGcp()) } });
  assert.equal(result.answer, 'yes');
  const path = result.execution.path;
  const at = path.indexOf(assumesProd);
  assert.deepEqual(path.slice(at + 1, at + 3), ['service account bindings admit repo:acme/functions:ref:refs/heads/main',
    'gcp:roles/cloudfunctions.developer acme-functions-prod (declared in policy, not provider-evaluated)']);
  const text = renderResult(result, { designated: ['gcp'] });
  assert.ok(!text.includes('no credential designated'));
  assert.ok(!JSON.stringify(result).includes('reader-token-from-file'));
  assert.match(renderComparison([{ label: 'broad', result }], { designated: ['gcp'] }), /Cloud actions on reported path\s+[1-9]/);
}));

test('application code alone is not clear: the deploy job runs repository code', async () => {
  const result = await check(writer(['src/index.ts']));
  assert.equal(result.answer, 'unknown');
  assert.ok(result.execution.limitations.includes('src/index.ts may be run or loaded by repository code.'));
  assert.ok(result.execution.path.includes(assumesProd));
});

test('a writable package manifest run by npm only in a job without credentials is not a finding', () => inDirectory({
  'ci.yml': 'on: push\npermissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci && npm test\n',
  'deploy.yml': readFileSync(join(workflows, 'deploy.yml'), 'utf8').replace(/      - run: npm ci && npm run build\n/, '')
    .replace(/  hosting:[\s\S]*$/, ''),
}, async directory => {
  const result = await check(writer(['package.json']), { directory });
  assert.equal(result.answer, 'unknown');
  assert.ok(result.execution.limitations.some(item => item.startsWith('package.json is a manifest')));
}));

test('docs referenced by a workflow are not clear', () => inDirectory({
  'docs.yml': 'on: push\njobs:\n  publish:\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./scripts/publish.sh docs/guide.md\n',
}, async directory => {
  const result = await check(writer(['docs/guide.md']), { directory });
  assert.equal(result.answer, 'unknown');
  assert.ok(result.execution.limitations.some(item => item.startsWith('docs/guide.md is referenced by')));
}));

test('a service account held in a secret is named by reference, never guessed, and untrusted workflow text is escaped', () => inDirectory({
  'deploy.yml': readFileSync(join(workflows, 'deploy.yml'), 'utf8')
    .replace('deployer@${{ env.PROJECT }}.iam.gserviceaccount.com', '"${{ secrets.GCP_SA_EMAIL }}\\u001b[31m"'),
}, async directory => withGcpReader(async tokenFile => {
  const calls: string[] = [];
  const result = await check(writer(['scripts/deploy-functions.sh']), { directory, workflowIdentity: { gcp: gcpServiceAccounts(tokenFile, new Set(), recordedGcp(calls)) } });
  assert.equal(result.answer, 'yes');
  assert.equal(calls.length, 0);
  assert.ok(result.execution.path.includes('requests gcp credentials from service_account ${{ secrets.GCP_SA_EMAIL }}\u001b[31m (unresolved)'));
  const text = renderResult(result);
  assert.match(text, /requests gcp credentials from service_account \$\{\{ secrets\.GCP_SA_EMAIL \}\}\\u001b\[31m \(unresolved\)/);
  assert.ok(!text.includes('\u001b'));
  assert.match(renderComparison([{ label: 'broad', result }]), /Identities on reported path\s+gcp unresolved \(secrets\.GCP_SA_EMAIL\)/);
})));

test('local workflows never stand in for another repository', async () => {
  const agent = writer(['docs/guide.md'], 'acme/other');
  const result = await checkBoundary({ agent, workflows: localWorkflows(workflows, { repository: 'acme/functions', branch: 'main' }) });
  assert.equal(result.answer, 'unknown');
  assert.ok(result.execution.limitations.includes('Repository evidence collection is incomplete.'));
  const two = writer(['docs/guide.md']);
  assert.throws(() => singleScope({ ...two, grants: [...two.grants, ...writer(['docs/a.md'], 'acme/other').grants] }), /exactly one/);
});

test('grants modules must export subject, tools and grants', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boundary-agent-'));
  try {
    writeFileSync(join(directory, 'bad.mjs'), 'export default { subject: "agent:x" };\n');
    await assert.rejects(loadAgent(join(directory, 'bad.mjs')), /must export \{ subject, tools, grants \}/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the comparison shows the change narrowing makes', async () => {
  const runs = [{ label: 'broad', result: await check(await loadAgent(join(root, 'agents/broad.ts'))) },
    { label: 'restricted', result: await check(await loadAgent(join(root, 'agents/restricted.ts'))) }];
  const text = renderComparison(runs);
  assert.match(text, /Writable files\s+4\s+1\n/);
  assert.match(text, /workflow-execution\s+FINDING\s+CLEAR/);
  assert.match(text, /Identities on reported path\s+deployer@acme-functions-prod, deployer@acme-functions-dev \+1\s+-/);
  assert.match(text, /Preflight admission\s+blocked\s+admitted/);
  assert.match(text, /Narrowing the grants changed the result: FINDING -> CLEAR\./);
});

test('GitHub reads treat unreadable Actions settings as enabled and say so', async () => {
  const content = Buffer.from(readFileSync(join(workflows, 'deploy.yml'))).toString('base64');
  const fake = (settings: number, enabled = true): typeof fetch => async input => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path.endsWith('/actions/permissions')) return settings === 200 ? Response.json({ enabled }) : new Response('{}', { status: settings });
    if (path.includes('/commits/')) return Response.json({ sha: 'a'.repeat(40) });
    if (path.endsWith('/contents/.github/workflows')) return Response.json([{ type: 'file', path: '.github/workflows/deploy.yml' }]);
    if (path.endsWith('/contents/.github/workflows/deploy.yml')) return Response.json({ encoding: 'base64', content });
    return new Response('{}', { status: 404 });
  };
  for (const status of [403, 404]) {
    const notes = new Set<string>();
    const evidence = await githubWorkflows('token', notes, fake(status))('acme/functions', 'main', new AbortController().signal);
    assert.equal(evidence.actionsEnabled, true);
    assert.equal(evidence.workflows.length, 1);
    assert.deepEqual([...notes], ['Actions settings for acme/functions need admin access to read, so Actions is treated as enabled.']);
  }
  const notes = new Set<string>();
  const readable = await githubWorkflows('token', notes, fake(200, false))('acme/functions', 'main', new AbortController().signal);
  assert.equal(readable.actionsEnabled, false);
  assert.equal(notes.size, 0);
  // Other failures are not masked: the runtime reports them as incomplete evidence.
  await assert.rejects(githubWorkflows('token', new Set(), fake(500))('acme/functions', 'main', new AbortController().signal));
});

test('real-world-sized paths list each service account once and stay readable', async () => {
  const result = await check(await loadAgent(join(root, 'agents/broad.ts')));
  const jobs = Array.from({ length: 20 }, (_, index) => [`acme/functions@main:.github/workflows/build.yml#job-${index}`,
    assumesProd, 'identity authority not assessed']).flat();
  const large = { ...result, execution: { ...result.execution, path: jobs } };
  const text = renderResult(large);
  assert.match(text, /\.\.\. 48 more steps \(use --report or --json for all\)/);
  assert.equal(text.split('\n').filter(line => line.trim() === `gcp ${prod}`).length, 1);
  assert.match(renderComparison([{ label: 'broad', result: large }]), /Identities on reported path\s+deployer@acme-functions-prod\n/);
});

const cli = promisify(execFile);
async function runCli(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await cli(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args],
      { cwd: root, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, timeout: 120000 });
    return { code: 0, stdout, stderr };
  } catch (error: any) { return { code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }; }
}
const fixture = 'fixtures/functions/workflows';
test('CLI exit codes describe the answer', async () => {
  const restricted = await runCli(['--grants', 'agents/restricted.ts', '--workflows', fixture]);
  assert.equal(restricted.code, 0);
  assert.match(restricted.stdout, /NO RECOGNIZED PATH/);
  assert.match(restricted.stdout, /\nInspected 1 workflow file\(s\) from fixtures\/functions\/workflows\.\n/);
  const broad = await runCli(['--grants', 'agents/broad.ts', '--workflows', fixture, '--report']);
  assert.equal(broad.code, 1);
  assert.match(broad.stdout, /II Agent Runtime \| Permission preflight/);
  assert.match(broad.stderr, /without --gcp-token-file, GCP service accounts/);
  const json = await runCli(['--grants', 'agents/broad.ts', '--compare', 'agents/restricted.ts', '--workflows', fixture, '--json']);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout).map((run: any) => [run.label, run.check.status]), [['broad', 'finding'], ['restricted', 'clear']]);
});
test('CLI rejects incomplete or unsafe configuration', async () => {
  for (const [args, message] of [
    [['--workflows', fixture], /--grants is required/],
    [['--grants', 'agents/broad.ts'], /exactly one of --workflows or --github/],
    [['--grants', 'agents/broad.ts', '--github'], /GITHUB_TOKEN/],
    [['--grants', 'agents/broad.ts', '--workflows', fixture, '--gcp-token-file', 'token'], /--gcp-token-file must be an absolute path/],
  ] as [string[], RegExp][]) {
    const result = await runCli(args);
    assert.equal(result.code, 64);
    assert.match(result.stderr, message);
  }
});

const grantsSource = readFileSync(join(root, 'agents/broad.ts'), 'utf8');
test('grants files outside this folder, globs and directories fail in plain words', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'boundary-outside-'));
  // Inside the checker folder, so the runtime import resolves.
  const inside = mkdtempSync(join(root, 'test', '.grants-'));
  try {
    writeFileSync(join(outside, 'coder.ts'), grantsSource);
    await assert.rejects(loadAgent(join(outside, 'coder.ts')), /^Error: Grants files must be inside this checker folder \(for example agents\/coder\.ts\) so they use the checker's runtime\. Move .*coder\.ts there\.$/);
    const cli = await runCli(['--grants', join(outside, 'coder.ts'), '--workflows', fixture]);
    assert.equal(cli.code, 64);
    assert.match(cli.stderr, /^Grants files must be inside this checker folder/);
    assert.doesNotMatch(cli.stderr, /Require stack|Cannot find/);
    writeFileSync(join(inside, 'glob.ts'), grantsSource.replace("'docs/guide.md'", "'scripts/**'"));
    await assert.rejects(loadAgent(join(inside, 'glob.ts')),
      /glob\.ts: createGrant rejected 'scripts\/\*\*' \(TOOL_INVALID_CONSTRAINT\)\. Grant paths are exact file paths, up to 256 per grant: no globs \(\*\) and no directories\./);
    writeFileSync(join(inside, 'folder.ts'), grantsSource.replace("'docs/guide.md'", "'scripts/'"));
    await assert.rejects(loadAgent(join(inside, 'folder.ts')), /folder\.ts: grant path 'scripts\/' is a directory\./);
    await assert.rejects(loadAgent(join(inside, 'missing.ts')), /^Error: Grants file .*missing\.ts not found\.$/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(inside, { recursive: true, force: true });
  }
});

test('a directory without workflow files is a configuration error, never a clear answer', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'boundary-repository-'));
  try {
    mkdirSync(join(repository, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repository, '.github', 'workflows', 'deploy.yml'), readFileSync(join(workflows, 'deploy.yml')));
    const root = await runCli(['--grants', 'agents/restricted.ts', '--workflows', repository]);
    assert.equal(root.code, 64);
    assert.ok(root.stderr.startsWith(`No workflow files (.yml/.yaml) in ${repository}. Did you mean ${join(repository, '.github', 'workflows')}?\n`), root.stderr);
    assert.equal(root.stdout, '');
    // The suggestion appears only when that directory exists.
    assert.throws(() => localWorkflows(join(repository, '.github'), { repository: 'acme/functions', branch: 'main' }),
      (error: Error) => error.message === `No workflow files (.yml/.yaml) in ${join(repository, '.github')}.`);
    const checked = await runCli(['--grants', 'agents/restricted.ts', '--workflows', join(repository, '.github', 'workflows')]);
    assert.equal(checked.code, 0);
    assert.match(checked.stdout, /Inspected 1 workflow file\(s\) from .*\.github\/workflows\./);
  } finally { rmSync(repository, { recursive: true, force: true }); }

  // On GitHub, a branch without .github/workflows would otherwise be clear for documentation.
  const empty: typeof fetch = async input => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path.endsWith('/actions/permissions')) return Response.json({ enabled: true });
    if (path.includes('/commits/')) return Response.json({ sha: 'b'.repeat(40) });
    return new Response('{}', { status: 404 });
  };
  const notes = new Set<string>();
  const result = await checkBoundary({ agent: writer(['docs/guide.md']), workflows: githubWorkflows('token', notes, empty) });
  assert.equal(result.answer, 'no');
  assert.deepEqual(result.inspected.map(item => [item.repository, item.workflows.length]), [['acme/functions', 0]]);
  assert.equal(notes.size, 0);
  assert.throws(() => requireWorkflowFiles(result, 'agents/mine.ts'),
    /^Error: No workflow files \(\.yml\/\.yaml\) in \.github\/workflows of acme\/functions@main on GitHub, so there is nothing to check\. Check repository and branch in agents\/mine\.ts\.$/);
  // A repository the token cannot read is named with its HTTP status.
  const missing = new Set<string>();
  const unread = await checkBoundary({ agent: writer(['docs/guide.md']), workflows: githubWorkflows('token', missing, async () => new Response('{}', { status: 404 })) });
  assert.equal(unread.answer, 'unknown');
  assert.ok([...missing].some(note => note.startsWith('GitHub /repos/acme/functions/commits/main returned HTTP 404 (not found: check repository and branch')), [...missing].join('\n'));
  assert.match(renderResult(unread), /Why:\n  - Repository evidence collection is incomplete\.\n/);
  assert.match(renderResult(unread), /Inspected no workflow files: they could not be read\./);
});

test('GCP setup mistakes fail at startup with exit 64; failed GCP reads name their HTTP status', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boundary-setup-'));
  try {
    const token = join(directory, 'token');
    assert.throws(() => checkGcpTokenFile(token), /--gcp-token-file \S+ cannot be read\. Create it with: gcloud auth print-access-token >/);
    const absent = await runCli(['--grants', 'agents/broad.ts', '--workflows', fixture, '--gcp-token-file', token]);
    assert.equal(absent.code, 64);
    assert.match(absent.stderr, /^--gcp-token-file \S+ cannot be read\./);
    writeFileSync(token, '\n');
    const empty = await runCli(['--grants', 'agents/broad.ts', '--workflows', fixture, '--gcp-token-file', token]);
    assert.equal(empty.code, 64);
    assert.match(empty.stderr, /^--gcp-token-file \S+ is empty\./);

    writeFileSync(token, 'reader-token-from-file\n');
    const notes = new Set<string>();
    const denied = await check(writer(['scripts/deploy-functions.sh']), { workflowIdentity: { gcp: gcpServiceAccounts(token, notes, async () => new Response('{}', { status: 403 })) } });
    assert.equal(denied.answer, 'yes');
    assert.ok(notes.has(`GCP read of ${prod}'s IAM policy returned HTTP 403 (permission denied: see the reader roles in the README).`), [...notes].join('\n'));
    assert.ok(notes.has(`GCP read of project acme-functions-prod's IAM policy returned HTTP 403 (permission denied: see the reader roles in the README).`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("can't tell puts the deciding reason first and names the job", () => inDirectory({
  'deploy.yml': readFileSync(join(workflows, 'deploy.yml'), 'utf8'),
  // An unprivileged pull_request lint job mentions docs/; only the deploy jobs hold credentials.
  'lint.yml': 'on: pull_request\npermissions:\n  contents: read\njobs:\n  lint:\n    runs-on: ubuntu-latest\n' +
    '    steps:\n      - uses: actions/checkout@v4\n      - run: npx markdownlint-cli docs/\n',
}, async directory => {
  const narrow = await check(writer(['docs/guide.md']), { directory });
  assert.equal(narrow.answer, 'unknown');
  const text = renderResult(narrow);
  const why = text.indexOf("CAN'T TELL: the evidence does not establish either answer.\nWhy:\n  - docs/guide.md is referenced by acme/functions@main:.github/workflows/lint.yml#lint.\n");
  const jobs = text.indexOf("Jobs that hold credentials (this check did not link them to the agent's files):\n  1. acme/functions@main:.github/workflows/deploy.yml#functions\n");
  assert.ok(why > 0 && jobs > why, text);
  assert.ok(!text.includes('Path'));
  assert.ok(!text.slice(text.indexOf('\nNotes:')).includes('is referenced by'), 'the deciding reason is not repeated in the notes');
  const broad = await check(writer(['scripts/deploy-functions.sh']), { directory });
  const comparison = renderComparison([{ label: 'broad', result: broad }, { label: 'narrow', result: narrow }]);
  assert.match(comparison, /Reported path: for a finding, the jobs that run the agent's files; for can't tell, every job that holds credentials\./);
}));

test('a local checkout of another repository or branch is named', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'boundary-checkout-'));
  try {
    mkdirSync(join(checkout, '.git'));
    mkdirSync(join(checkout, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(checkout, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:someone/their-app.git\n');
    writeFileSync(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/dev\n');
    assert.deepEqual(checkoutOf(join(checkout, '.github', 'workflows')), { repository: 'someone/their-app', branch: 'dev' });
    writeFileSync(join(checkout, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/functions\n');
    assert.deepEqual(checkoutOf(join(checkout, '.github', 'workflows')), { repository: 'acme/functions', branch: 'dev' });
    // Only a checkout's own .github/workflows is matched; fixtures and other folders are not.
    assert.deepEqual(checkoutOf(workflows), {});
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});
