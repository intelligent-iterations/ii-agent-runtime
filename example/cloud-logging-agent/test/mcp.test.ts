import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startGateway } from '../src/gateway.js';
import { loadWorkerFiles } from '../src/worker-files.js';
import { readdirSync } from 'node:fs';

test('MCP discovery and rejected invocation use the real runtime gateway', async () => {
  let resolutions = 0;
  const gateway = await startGateway({ project: 'ii-demo-checkout', resourceType: 'cloud_function', resource: 'checkout', address: '127.0.0.1',
    deadlineMs: Date.now() + 60000, signal: new AbortController().signal,
    resolveCredential: async () => { resolutions++; throw Error('Unexpected credential request'); },
    model: { respond: async () => new Response(null, { status: 403 }) } });
  const client = new Client({ name: 'cloud-logging-contract-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../worker/mcp.mjs', import.meta.url))],
      env: { PATH: process.env.PATH!, AGENT_GATEWAY_URL: gateway.endpoint, AGENT_GATEWAY_TOKEN: gateway.token } }));
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(tool => tool.name), ['cloudLoggingErrors']);
    const result = await client.callTool({ name: 'cloudLoggingErrors', arguments: { project: 'ii-demo-payments', resource: 'checkout', startTime: 1000, endTime: 2000 } });
    assert.equal(result.isError, true); assert.match(JSON.stringify(result), /HTTP 403/);
    const mutation = await client.callTool({ name: 'deleteLog', arguments: { project: 'ii-demo-checkout', logName: 'cloud-functions' } });
    assert.equal(mutation.isError, true); assert.equal(resolutions, 0);
  } finally { await client.close(); await gateway.close(); }
});

test('only allowlisted worker files cross the application boundary', async () => {
  await loadWorkerFiles({ workspace: '/workspace',
    load: async directory => { assert.deepEqual(readdirSync(directory).sort(), ['mcp.mjs', 'package-lock.json', 'package.json', 'probe.mjs', 'run.mjs']); },
    run: async () => '', setup: async () => ({ exitCode: 0, seconds: 0, timedOut: false }),
    isolate: async () => { throw Error('Not used'); } });
});
