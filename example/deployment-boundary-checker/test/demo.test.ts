import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// npm run test:demo: the demo's own command from package.json (same CLI, arguments and grants files), with
// api.github.com replaced by recorded responses (test/recorded-github.mjs). It needs no network and no token.
// GITHUB_RECORD=1 with a real GITHUB_TOKEN re-records the responses from GitHub and checks the live result instead.
const root = fileURLToPath(new URL('../', import.meta.url));
const demo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.demo.split(' ') as string[];
const fixture = join(root, 'fixtures/demo-github-responses.json');
const recording = () => JSON.parse(readFileSync(fixture, 'utf8')) as { responses: { url: string; status: number; body: any }[] };
const record = process.env.GITHUB_RECORD === '1';
const repository = 'GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp';
const account = 'gh-e2e-runner@secretmanager-csi-build.iam.gserviceaccount.com';

const execute = promisify(execFile);
/** Runs the demo command as npm run demo does, and returns its output and every GitHub request it made. */
async function runDemo(env: Record<string, string>) {
  assert.deepEqual(demo.slice(0, 2), ['tsx', 'src/cli.ts'], 'scripts.demo runs the CLI with tsx');
  const directory = mkdtempSync(join(tmpdir(), 'boundary-demo-'));
  const log = join(directory, 'requests.json');
  const options = { cwd: root, timeout: 120000, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, npm_lifecycle_event: 'demo',
    GITHUB_REQUEST_LOG: log, ...(record ? { GITHUB_RECORD: '1' } : {}), ...env } };
  try {
    let result: { code: number; stdout: string; stderr: string };
    try {
      const { stdout, stderr } = await execute(process.execPath, ['--import', 'tsx', '--import', './test/recorded-github.mjs', ...demo.slice(1)], options);
      result = { code: 0, stdout, stderr };
    } catch (error: any) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    return { ...result, requests: JSON.parse(readFileSync(log, 'utf8')) as string[] };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** The section of the comparison output for one grants file. */
const section = (stdout: string, label: string) => stdout.slice(stdout.indexOf(`=== ${label} ===`)).split(/\n=== /)[0]!;

test('the demo: broad grants reach the keyless GCP e2e job (YES), README only is clear', async () => {
  if (record) assert.ok(process.env.GITHUB_TOKEN, 'Recording reads GitHub: run GITHUB_TOKEN=$(gh auth token) GITHUB_RECORD=1 npm run test:demo');
  const { code, stdout, stderr, requests } = await runDemo({ GITHUB_TOKEN: record ? process.env.GITHUB_TOKEN! : 'recorded-responses-need-no-token' });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /workflow-execution\s+FINDING\s+CLEAR\n/);
  assert.match(stdout, /Preflight admission\s+blocked\s+admitted\n/);
  assert.match(stdout, /Narrowing the grants changed the result: FINDING -> CLEAR\./);

  const broad = section(stdout, 'broad');
  assert.match(broad, /\n  YES: a workflow job with deployment credentials runs a file this agent can write\.\n/);
  assert.ok(broad.includes(['Path:', `  1. contents.write ${repository}@main:test/infra/runner.sh`,
    `  2. ${repository}@main:.github/workflows/e2e.yml#e2e-test`,
    `  3. assumes gcp ${account} via OIDC through projects/735463103342/locations/global/workloadIdentityPools/github-pool/providers/github-provider`,
    '  4. gcp authority not assessed (no credential designated)'].join('\n')), broad);
  assert.match(broad, /Preflight admission: blocked/);
  const restricted = section(stdout, 'restricted');
  assert.match(restricted, /\n  NO RECOGNIZED PATH: no inspected workflow runs or references anything this agent can write\.\n/);
  assert.match(restricted, /Inspected 3 workflow file\(s\) from GitHub GoogleCloudPlatform\/secrets-store-csi-driver-provider-gcp@main at commit [0-9a-f]{12}\./);
  assert.match(restricted, /Preflight admission: admitted/);
  assert.match(stderr, /Note: Actions settings for GoogleCloudPlatform\/secrets-store-csi-driver-provider-gcp need admin access to read/);

  // Each grants file reads the same evidence, and every request has a recording: nothing else is called.
  const urls = recording().responses.map(item => `GET ${item.url}`);
  assert.deepEqual(requests, [...urls, ...urls]);
  assert.deepEqual(urls.slice(0, 3).map(url => url.replace(/[0-9a-f]{40}/, '<commit>')), [
    `GET https://api.github.com/repos/${repository}/actions/permissions`,
    `GET https://api.github.com/repos/${repository}/commits/main`,
    `GET https://api.github.com/repos/${repository}/contents/.github/workflows?ref=<commit>`]);
  assert.doesNotMatch(stderr, /Refused/);
});

test('the README shows what the demo prints', async () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const seeItWork = readme.slice(readme.indexOf('\n## See it work'));
  const sample = /```text\n(Deployment boundary comparison\n[\s\S]*?)```/.exec(seeItWork)?.[1];
  assert.ok(sample, 'README "See it work" has the demo output');
  const { stdout, stderr } = await runDemo({ GITHUB_TOKEN: record ? process.env.GITHUB_TOKEN! : 'recorded-responses-need-no-token' });
  // The sample is trimmed: lines marked ... are left out, every other line appears in this order.
  let at = 0;
  const output = `${stdout}\n${stderr}`;
  for (const line of sample.split('\n').filter(line => line.trim() && line.trim() !== '...')) {
    const found = output.indexOf(line, at);
    assert.ok(found >= 0, `README line not in the demo output (or out of order): ${line}`);
    at = found + line.length;
  }
});

test('the demo without GITHUB_TOKEN: one plain line that names it and the fix, exit 64, no GitHub calls', async () => {
  const { code, stdout, stderr, requests } = await runDemo({});
  assert.equal(code, 64);
  assert.equal(stdout, '');
  assert.equal(stderr, "GITHUB_TOKEN is not set: the demo reads the repository's workflows from GitHub with your token. Run: GITHUB_TOKEN=$(gh auth token) npm run demo\n");
  assert.deepEqual(requests, []);
  assert.ok(readFileSync(join(root, 'README.md'), 'utf8').includes(`\n${stderr}`), 'the README shows this line');
});

test('the recording keeps no token or headers', () => {
  const text = readFileSync(fixture, 'utf8');
  assert.doesNotMatch(text, /\bgh[opsu]_[A-Za-z0-9]{20,}|github_pat_|authorization|bearer/i);
  for (const item of recording().responses) assert.deepEqual(Object.keys(item), ['url', 'status', 'body']);
});
