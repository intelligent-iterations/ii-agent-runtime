import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { commandSession } from '../../../../src/providers/execution/remote/channel.js';

test('command transport accepts fragmented replies and rejects unsolicited replies', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let stopped = 0;
  const session = commandSession(input, output, async () => { stopped++; });
  const request = session.request<string>('run', {}, 1000);
  assert.equal(JSON.parse(input.read().toString()).operation, 'run');
  output.write('{"id":1,"ok":true,"val'); output.write('ue":"done"}\n');
  assert.equal(await request, 'done');
  output.write('{"id":1,"ok":true}\n');
  await assert.rejects(session.request('run', {}, 1000), /unavailable/);
  await session.close(); await session.close(); assert.equal(stopped, 1);
});

test('aborted commands fail the session without permitting a replay', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const session = commandSession(input, output, async () => {});
  const abort = new AbortController();
  const request = session.request('provision', {}, 1000, abort.signal);
  abort.abort();
  await assert.rejects(request, /stream failed/);
  await assert.rejects(session.request('provision', {}, 1000), /unavailable/);
  await session.close();
});

test('remote tunnel requests cannot connect before the trusted gateway is selected', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const session = commandSession(input, output, async () => {});
  const request = session.request('run', {}, 1000);
  output.write('{"tunnel":1,"kind":"open","address":"169.254.169.254"}\n');
  await assert.rejects(request, /stream failed/);
  await session.close();
});
