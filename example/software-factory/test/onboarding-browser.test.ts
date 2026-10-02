import assert from 'node:assert/strict';
import { test } from 'node:test';
import { get } from 'node:http';
import { createHash } from 'node:crypto';
import { appName, openOnboardingBrowser } from '../src/onboarding-browser.js';

test('real loopback callback accepts one authenticated manifest response and rejects forged or replayed responses', async t => {
  const session = await openOnboardingBrowser('example'); t.after(() => session.close());
  const start = await fetch(session.startUrl);
  assert.equal(start.headers.get('cache-control'), 'no-store');
  const page = await start.text();
  assert.match(page, /https:\/\/github.com\/organizations\/example\/settings\/apps\/new/);
  const script = /<script>([^<]+)<\/script>/.exec(page)![1]!;
  const hash = createHash('sha256').update(script).digest('base64');
  assert.ok(start.headers.get('content-security-policy')?.includes(`script-src 'sha256-${hash}'`));
  assert.equal((page.match(/<script/g) ?? []).length, 1);
  const state = /state=([a-f0-9]{64})/.exec(page)![1]!;
  const created = String(session.manifest.redirect_url);
  assert.equal((await fetch(`${created}?state=bad&code=synthetic-code`)).status, 400);
  assert.equal((await fetch(`${created}?state=${state}&code=synthetic-code`)).status, 200);
  assert.equal(await session.code, 'synthetic-code');
  assert.equal((await fetch(`${created}?state=${state}&code=synthetic-code`)).status, 400);
  assert.equal((await fetch(`${session.manifest.setup_url}?installation_id=55&setup_action=install`)).status, 200);
  assert.equal(await session.installation, 55);
  assert.equal((await fetch(`${session.manifest.setup_url}?installation_id=56&setup_action=install`)).status, 400);
  const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    get(session.startUrl, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(forgedHostStatus, 400);
});

test('installation before creation, canceled sessions and timeout cannot complete onboarding', async () => {
  const session = await openOnboardingBrowser('example');
  assert.equal((await fetch(`${session.manifest.setup_url}?installation_id=55&setup_action=install`)).status, 400);
  await session.close();
  await assert.rejects(session.code, /closed/); await assert.rejects(session.installation, /closed/);
  const expired = await openOnboardingBrowser('example', { timeoutMs: 20 });
  await assert.rejects(expired.code, /closed/);
  await expired.close();
});

test("a fixed callback port is used for forwarded remote onboarding and invalid ports are refused", async t => {
  const probe = await openOnboardingBrowser("example"); const port = Number(new URL(probe.startUrl).port); await probe.close();
  const session = await openOnboardingBrowser("example", { port }); t.after(() => session.close());
  assert.equal(new URL(session.startUrl).port, String(port));
  assert.equal(new URL(String(session.manifest.redirect_url)).port, String(port));
  await assert.rejects(openOnboardingBrowser("example", { port }), /EADDRINUSE/);
  for (const invalid of [80, 70000, 1.5]) await assert.rejects(openOnboardingBrowser("example", { port: invalid }), /Invalid callback port/);
});

test('the default App name fits GitHub\'s 34-character limit', () => {
  assert.equal(appName('example'), 'Software Factory - example');
  assert.equal(appName('intelligent-iterations'), 'Software Factory - intelligent-ite');
  assert.equal(appName('abcdefghijklmnopq-rstuvwxyz'), 'Software Factory - abcdefghijklmno');
  for (const organization of ['a', 'intelligent-iterations', 'x'.repeat(39)]) assert.ok(appName(organization).length <= 34);
});
