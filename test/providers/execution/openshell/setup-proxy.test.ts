import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { openSetupProxy, publicSetupAddress, resolveSetupDestination } from '../../../../src/providers/execution/openshell/setup-proxy.js';

test('setup egress denies special IPv4 and every IPv6 destination', async () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '100.100.100.200', '172.16.1.1', '172.31.255.255', '192.168.1.1', '192.0.0.9', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', '2606:4700::1111']) assert.equal(publicSetupAddress(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '104.16.1.1']) assert.equal(publicSetupAddress(ip), true);
  await assert.rejects(resolveSetupDestination('127.0.0.1'), /denied/);
  await assert.rejects(resolveSetupDestination('user@example.com'), /denied/);
  const mixed = async () => ['1.1.1.1', '10.0.0.1'];
  await assert.rejects(resolveSetupDestination('example.com', mixed), /denied/);
  assert.equal(await resolveSetupDestination('example.com', async () => ['1.1.1.1', '8.8.8.8']), '1.1.1.1');
});

test('real setup proxy denies missing authentication, private destinations and alternate ports; closes on cancellation', async () => {
  const controller = new AbortController();
  const proxy = await openSetupProxy('127.0.0.1', controller.signal);
  const url = new URL(proxy.url);
  const authorization = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
  const get = (path: string, auth?: string) => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxy.port, path, ...(auth ? { headers: { 'proxy-authorization': auth } } : {}) }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal(await get('http://example.com/'), 403);
    assert.equal(await get('http://169.254.169.254/latest/meta-data', authorization), 403);
    assert.equal(await get('http://127.0.0.1/', authorization), 403);
    assert.equal(await get('http://example.com:8080/', authorization), 403);
    controller.abort();
    await assert.rejects(get('http://example.com/', authorization));
  } finally { proxy.close(); }
});
