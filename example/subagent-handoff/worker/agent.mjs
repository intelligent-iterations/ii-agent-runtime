// A minimal tool-calling agent. It receives only a gateway endpoint and token on stdin.
// Every model request and tool call goes through that gateway; it holds no model key or file access of its own.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { endpoint, token, model, instructions, task, maxTurns = 12 } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const steps = [];

async function readOutput(response) {
  const text = await response.text();
  if (text.length > 16_777_216) throw Error('Model stream too large');
  const done = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    const event = JSON.parse(data);
    if (event.type === 'response.output_item.done') done.push(event.item);
    if (event.type === 'response.completed') return event.response?.output?.length ? event.response.output : done;
    if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) throw Error(`Model response ${event.type}`);
  }
  return done;
}

const listed = await fetch(`${endpoint}/tools`, { headers });
if (!listed.ok) throw Error(`Tool discovery failed (HTTP ${listed.status})`);
const tools = (await listed.json()).map(tool => ({ type: 'function', name: tool.name, description: tool.description,
  parameters: tool.inputSchema, strict: false }));
const input = [{ role: 'user', content: task }];
let result = { status: 'incomplete', text: '', steps };
for (let turn = 0; turn < maxTurns; turn++) {
  const response = await fetch(`${endpoint}/v1/responses`, { method: 'POST', headers,
    body: JSON.stringify({ model, instructions, input, tools, parallel_tool_calls: false, stream: true, store: false }) });
  if (!response.ok) throw Error(`Model request denied (HTTP ${response.status})`);
  const output = await readOutput(response);
  const calls = output.filter(item => item.type === 'function_call');
  if (!calls.length) {
    const text = output.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
      .filter(part => part.type === 'output_text').map(part => part.text).join('');
    result = { status: 'completed', text, steps };
    break;
  }
  for (const call of calls) {
    input.push({ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments });
    let args = {};
    try { args = JSON.parse(call.arguments); } catch {}
    const answer = /^[A-Za-z0-9._-]+$/.test(call.name)
      ? await fetch(`${endpoint}/tools/${call.name}`, { method: 'POST', headers, body: call.arguments })
      : new Response('Invalid tool name', { status: 400 });
    const body = await answer.text();
    let detail;
    try { detail = JSON.parse(body); } catch {}
    steps.push({ tool: call.name, target: args.path ?? args.script ?? args.files?.join(', ') ?? '', status: answer.status,
      ...(typeof detail?.exitCode === 'number' ? { exitCode: detail.exitCode } : {}) });
    input.push({ type: 'function_call_output', call_id: call.call_id,
      output: answer.ok ? body.slice(0, 50_000) : JSON.stringify({ error: `Denied or failed (HTTP ${answer.status})` }) });
  }
}
process.stdout.write(JSON.stringify(result) + '\n');
