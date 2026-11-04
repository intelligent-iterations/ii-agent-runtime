import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Convenience transport only. Changing this client cannot widen the gateway's grant.
const endpoint = process.env.AGENT_GATEWAY_URL;
const headers = { authorization: `Bearer ${process.env.AGENT_GATEWAY_TOKEN}`, 'content-type': 'application/json' };
const server = new Server({ name: 'cloud-logging', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const response = await fetch(`${endpoint}/tools`, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('Gateway tool discovery failed');
  return { tools: await response.json() };
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (!/^[a-zA-Z0-9._-]+$/.test(params.name)) throw Error('Invalid tool');
  const response = await fetch(`${endpoint}/tools/${params.name}`, { method: 'POST', headers,
    body: JSON.stringify(params.arguments ?? {}), signal: AbortSignal.timeout(30000) });
  return { isError: !response.ok, content: [{ type: 'text', text: response.ok ? await response.text() : `Gateway rejected request (HTTP ${response.status}).` }] };
});
await server.connect(new StdioServerTransport());
