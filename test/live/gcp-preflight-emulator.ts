import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createGrant, createToolSession, defineTool } from '../../src/runtime/tools.js';
import { admitToolSession, preflightTools } from '../../src/runtime/preflight.js';
import { gcpEvidenceCollector } from '../../src/providers/tools/cloud-evidence.js';
import { gcpPermissionPreflight } from '../../src/providers/tools/preflight.js';
import { gcpCompute } from '../../src/providers/tools/gcp.js';
import { prepareTools } from '../../src/providers/tools/prepare.js';
import { openWorkerGateway } from '../../src/providers/gateway/worker.js';

const image = 'floci/floci-gcp@sha256:eae9683d806ceb643bcb36aee97cdb8cad13c3e2959cd053bf40e481994fde12';
const name = `ii-preflight-${randomUUID()}`;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 }).trim();
const root = '/compute/v1/projects/ii-preflight';
const zone = 'us-central1-a';
const identity = 'worker@ii-preflight.iam.gserviceaccount.com';
let container: string | undefined;
const result: Record<string, unknown> = { provider: 'gcp', emulator: 'floci-gcp', version: '0.11.0', image,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version, iamProof: false, status: 'failed' };
try {
  container = docker('run', '-d', '--name', name, '-p', '127.0.0.1::4588', image);
  const endpoint = `http://${docker('port', container, '4588/tcp')}`;
  async function api(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
    const value = await response.json() as any;
    if (value.kind === 'compute#operation' && method !== 'GET') {
      const operation = '/compute/v1/' + value.selfLink.split('/compute/v1/')[1];
      for (let i = 0; i < 100; i++) {
        const state = await api('GET', operation);
        if (state.status === 'DONE') { assert.ok(!state.error, JSON.stringify(state.error)); return state; }
        await delay(100);
      }
      throw Error('Emulator operation timeout');
    }
    return value;
  }
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { await api('GET', `${root}/zones/${zone}/machineTypes/e2-standard-2`); ready = true; break; }
    catch { await delay(500); }
  }
  assert.ok(ready, 'Upstream emulator must start');
  await api('POST', `${root}/global/networks`, { name: 'net', autoCreateSubnetworks: false });
  await api('POST', `${root}/regions/us-central1/subnetworks`, { name: 'subnet', network: 'projects/ii-preflight/global/networks/net', ipCidrRange: '10.42.0.0/24' });
  await api('POST', `${root}/zones/${zone}/disks`, { name: 'seed', sizeGb: '10' });
  await api('POST', `${root}/global/images`, { name: 'image', sourceDisk: `projects/ii-preflight/zones/${zone}/disks/seed` });
  await api('POST', `${root}/zones/${zone}/instances`, { name: 'worker', machineType: `zones/${zone}/machineTypes/e2-standard-2`,
    networkInterfaces: [{ subnetwork: 'projects/ii-preflight/regions/us-central1/subnetworks/subnet' }],
    disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage: 'projects/ii-preflight/global/images/image' } }],
    serviceAccounts: [{ email: identity, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }] });
  let reads = 0;
  const troubleshootingStatuses: number[] = [];
  // Change only transport destination. Do not synthesize or rewrite responses.
  const transport: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    assert.ok(['https://compute.googleapis.com', 'https://policytroubleshooter.googleapis.com'].includes(target.origin));
    assert.equal(init?.redirect, 'error');
    reads++;
    const response = await fetch(endpoint + target.pathname + target.search, init);
    if (target.hostname === 'policytroubleshooter.googleapis.com') troubleshootingStatuses.push(response.status);
    return response;
  };
  const signal = AbortSignal.timeout(60000);
  const subject = 'agent:emulator';
  const context = { executionId: 'emulator', attemptId: 'one', inputDigest: 'emulator', deadlineMs: Date.now() + 60000, signal };
  const resources = { project: ['ii-preflight'], zone: [zone], instance: ['worker'] };
  let resolutions = 0;
  const tools = ['compute.instances.setMetadata', 'compute.instances.reset'].map((id, index) => defineTool({ name: `assess-${index}`,
    credential: { provider: 'gcp', resource: 'emulator', key: 'synthetic', assignment: subject },
    operation: { provider: 'gcp', id, description: 'Assessment only', resourceFields: Object.keys(resources),
      inputSchema: { type: 'object', additionalProperties: false, required: Object.keys(resources),
        properties: Object.fromEntries(Object.keys(resources).map(key => [key, { type: 'string' }])) },
      execute: async () => { throw Error('No escalation operation is executed'); } } }));
  const session = createToolSession({ subject, tools, context, grants: tools.map(tool => createGrant({ subject, tool, resources })),
    resolveCredential: async () => { resolutions++; throw Error('Preflight must not resolve credentials'); } });
  const collect = gcpEvidenceCollector({ token: async () => 'synthetic-reader', fetch: transport });
  const evidence = await collect({ subject, tools, grants: session.grants, now: Date.now(), signal });
  assert.ok(evidence.resources.some(item => item.executionIdentity === identity), 'Attached identity must survive the upstream API');
  assert.equal(troubleshootingStatuses.length, 4);
  result.troubleshooterHttpStatuses = troubleshootingStatuses;
  assert.ok(troubleshootingStatuses.every(status => status === 406), 'Pinned emulator rejects Policy Troubleshooter requests with HTTP 406');
  assert.ok(evidence.resources.some(item => item.limitations?.some(limit => limit.includes('Policy Troubleshooter is unavailable'))));
  result.policyTroubleshooter = 'unavailable in upstream emulator (HTTP 406)';
  const report = await preflightTools(session, { signal, inspectors: [gcpPermissionPreflight(async () => evidence)] });
  assert.equal(report.checks.find(item => item.id === 'gcp.startup-code')?.status, 'unknown');
  assert.throws(() => admitToolSession(session, report), /PREFLIGHT_REQUIREMENT_UNMET/);
  assert.equal(resolutions, 0);
  result.identityCollection = 'passed';
  result.missingAuthorityBlocksAdmission = 'passed';

  const read = defineTool({ name: 'read-instance', operation: gcpCompute({ fetch: transport }).getInstance,
    credential: { provider: 'gcp', resource: 'emulator', key: 'synthetic', assignment: subject } });
  const prepared = await prepareTools({ subject, tools: [read], context, grants: [createGrant({ subject, tool: read, resources })],
    resolveCredential: async () => { resolutions++; return { values: { accessToken: 'synthetic-execution-key' }, expiresAt: context.deadlineMs }; } });
  const gateway = await openWorkerGateway({ address: '127.0.0.1', grants: [], tools: prepared.session, signal,
    model: { respond: async () => { throw Error('Model not used'); } } });
  try {
    const call = (instance: string) => fetch(`${gateway.endpoint}/tools/read-instance`, { method: 'POST',
      headers: { authorization: `Bearer ${gateway.token}` }, body: JSON.stringify({ project: 'ii-preflight', zone, instance }) });
    const allowed = await call('worker');
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json() as { name: string }).name, 'worker');
    const before = { reads, resolutions };
    assert.equal((await call('not-granted')).status, 403);
    assert.deepEqual({ reads, resolutions }, before, 'Denied request cannot resolve credentials or reach emulator');
    result.gatewayAllowedAndDenied = 'passed';
  } finally { await gateway.close(); }
  await api('DELETE', `${root}/zones/${zone}/instances/worker`);
  assert.equal((await api('GET', `${root}/zones/${zone}/instances`)).items?.length ?? 0, 0);
  const missing = await collect({ subject, tools, grants: session.grants, now: Date.now(), signal });
  assert.equal(missing.resources.length, 0);
  result.deletedResourceNegativeControl = 'passed';
  for (const path of [`${root}/global/images/image`, `${root}/zones/${zone}/disks/seed`, `${root}/regions/us-central1/subnetworks/subnet`, `${root}/global/networks/net`]) await api('DELETE', path);
  result.resourceCleanup = 'passed';
  result.status = 'passed';
} finally {
  if (container) {
    docker('rm', '-f', container);
    assert.ok(!docker('ps', '-a', '--filter', `name=${name}`, '--format', '{{.ID}}'));
    result.emulatorCleanup = 'passed';
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
