import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const { endpoint, token } = JSON.parse(raw);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
assert.equal(Object.keys(process.env).some(key => /^(GOOGLE_|CLOUDSDK_|GCLOUD_|AWS_|OPENAI_API_KEY)/.test(key)), false);
assert.equal(existsSync('/var/run/docker.sock'), false);
// No gcloud configuration in root's or any user's home directory.
const homes = ['/root', ...(existsSync('/home') ? readdirSync('/home').map(name => join('/home', name)) : [])];
for (const home of homes) assert.equal(existsSync(join(home, '.config', 'gcloud')), false, `${home}/.config/gcloud exists`);
const tools = await (await fetch(`${endpoint}/tools`, { headers })).json();
assert.equal(tools.length, 1); assert.equal(tools[0].name, 'cloudLoggingErrors');
const now = Date.now();
const response = await fetch(`${endpoint}/tools/cloudLoggingErrors`, { method: 'POST', headers,
  body: JSON.stringify({ project: 'not-authorized-project', resource: 'not-authorized', startTime: now - 60000, endTime: now }) });
assert.equal(response.status, 403);
for (const destination of ['http://1.1.1.1', 'http://169.254.169.254/computeMetadata/v1/', 'https://logging.googleapis.com']) {
  const reachable = await fetch(destination, { signal: AbortSignal.timeout(1500), headers: { 'Metadata-Flavor': 'Google' } }).then(() => true, () => false);
  assert.equal(reachable, false, `Unexpected egress: ${destination}`);
}
console.log('Worker probe passed: gateway reachable, denied resource rejected, external/metadata/Google API egress unavailable, no Google/AWS/OpenAI environment or host credential/socket mounts.');
