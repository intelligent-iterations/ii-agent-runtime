import { isIPv4 } from 'node:net';
import type { PipelineTask, Worker } from '../../../pipeline/ports.js';
import type { CompiledConfiguration } from '../../../runtime/configuration.js';

// Executed inside the externally isolated container. All user input arrives as JSON on stdin.
export const CODEX_WORKER_PROGRAM = String.raw`
const { execFileSync, spawn } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, rmSync } = require('node:fs');
(async () => {
  let source = '';
  for await (const chunk of process.stdin) { source += chunk; if (Buffer.byteLength(source) > 1048576) throw Error('Input limit'); }
  const input = JSON.parse(source);
  const home = input.workspace + '/user';
  const cwd = input.workspace + '/repository';
  // Codex refuses to start when CODEX_HOME does not exist, before sending any model request.
  mkdirSync(home + '/codex', { recursive: true, mode: 0o700 });
  // /tmp is noexec; tools that build or run from a temporary directory use the workspace instead.
  mkdirSync(input.workspace + '/tmp', { recursive: true, mode: 0o700 });
  // A fresh git configuration: dependency setup ran in this workspace before, and must not choose git settings for the agent.
  const gitConfig = home + '/agent-runtime.gitconfig';
  rmSync(gitConfig, { force: true });
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: home + '/codex',
    AGENT_GATEWAY_TOKEN: input.token, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig, TMPDIR: input.workspace + '/tmp' };
  const run = (command, args) => execFileSync(command, args, { env, timeout: 60000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
  if (run('codex', ['--version']) !== 'codex-cli ' + input.version) throw Error('Codex version mismatch');
  // The agent phase must have no route to the internet; refuse to start if it does.
  const reachable = await fetch('https://registry.npmjs.org/', { signal: AbortSignal.timeout(5000) }).then(() => true, () => false);
  if (reachable) throw Error('Worker reached the internet');
  run('git', ['config', '--global', 'http.' + input.endpoint + '/.extraHeader', 'Authorization: Basic ' + Buffer.from('agent:' + input.token).toString('base64')]);
  // The source host's remotes are served by the gateway; the agent's git commands keep their usual URLs.
  run('git', ['config', '--global', 'url.' + input.gatewayPrefix + '.insteadOf', input.remotePrefix]);
  run('git', ['config', '--global', 'core.hooksPath', '/dev/null']);
  run('git', ['config', '--global', 'user.name', input.authorName]);
  run('git', ['config', '--global', 'user.email', input.authorEmail]);
  // The trusted host checked out the base branch and loaded it here; the task branch starts from it.
  if (!existsSync(cwd + '/.git')) throw Error('Repository not loaded');
  appendFileSync(cwd + '/.git/info/exclude', '\nnode_modules/\n.venv/\n');
  run('git', ['-C', cwd, 'switch', '-c', input.branch]);
  const config = {
    model_provider: 'gateway',
    'model_providers.gateway.name': 'Agent runtime gateway',
    'model_providers.gateway.base_url': input.endpoint + '/v1',
    'model_providers.gateway.env_key': 'AGENT_GATEWAY_TOKEN',
    'model_providers.gateway.wire_api': 'responses',
    'model_providers.gateway.requires_openai_auth': false,
    'model_providers.gateway.supports_websockets': false,
    'model_providers.gateway.request_max_retries': 0,
    'model_providers.gateway.stream_max_retries': 0,
    web_search: 'disabled',
  };
  const args = ['--ask-for-approval', 'never', 'exec', '--sandbox', 'danger-full-access', '--json', '--ephemeral',
    '--ignore-user-config', '--ignore-rules', '--model', input.model, '--cd', cwd];
  for (const [key, value] of Object.entries(config)) args.push('-c', key + '=' + JSON.stringify(value));
  args.push('-');
  const child = spawn('codex', args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let bytes = 0;
  let limited = false;
  // A content-free account of the run from Codex's JSON events: how many commands, which programs failed (names and
  // exit codes only, never arguments or output), and the agent's last message, shortened.
  const activity = { commands: 0, failed: [], messages: 0, lastMessage: '', errors: [] };
  let pending = '';
  const observe = line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const item = event && event.type === 'item.completed' ? event.item || {} : undefined;
    if (item && item.type === 'command_execution') {
      activity.commands++;
      if (item.exit_code !== 0 && activity.failed.length < 10) {
        const inner = String(item.command || '').replace(/^\S+ -\w*c\s+/, '').replace(/^['"]/, '').trim();
        activity.failed.push({ program: (inner.split(/[\s;|&<>()'"]/)[0] || '?').split('/').pop().slice(0, 40), exitCode: Number.isInteger(item.exit_code) ? item.exit_code : -1 });
      }
    } else if (item && item.type === 'agent_message') { activity.messages++; activity.lastMessage = String(item.text || '').slice(0, 1500); }
    else if ((event.type === 'error' || event.type === 'turn.failed') && activity.errors.length < 5) activity.errors.push(String(event.message || (event.error && event.error.message) || '').slice(0, 300));
  };
  const consume = chunk => { bytes += chunk.length; if (bytes > 16777216) { limited = true; child.kill('SIGKILL'); } };
  child.stdout.on('data', chunk => {
    consume(chunk);
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop().slice(-1048576);
    lines.forEach(observe);
  });
  child.stderr.on('data', consume);
  const timer = setTimeout(() => { limited = true; child.kill('SIGKILL'); }, input.timeoutMs);
  const code = await new Promise((resolve, reject) => {
    child.on('error', () => reject(Error('Codex could not start')));
    child.stdin.on('error', () => child.kill('SIGKILL'));
    child.on('close', exitCode => resolve(exitCode));
    child.stdin.end(input.prompt);
  }).finally(() => clearTimeout(timer));
  if (limited || !Number.isInteger(code)) throw Error('Worker execution interrupted');
  const head = run('git', ['-C', cwd, 'rev-parse', 'HEAD']);
  const dirty = run('git', ['-C', cwd, 'status', '--porcelain']).length > 0;
  observe(pending);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, exitCode: code, head, dirty, branch: input.branch, activity }));
})().catch(() => { process.stderr.write('Worker execution failed.'); process.exitCode = 1; });
`;

export interface WorkerActivity { commands: number; failed: Array<{ program: string; exitCode: number }>; messages: number; lastMessage: string; errors: string[] }
/** Accepts only the bounded, content-free shape the worker reports; anything else is dropped rather than trusted. */
function workerActivity(value: unknown): WorkerActivity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const count = (entry: unknown) => Number.isSafeInteger(entry) && (entry as number) >= 0 ? entry as number : 0;
  const text = (entry: unknown, limit: number) => typeof entry === 'string' ? entry.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, limit) : '';
  return {
    commands: count(raw.commands), messages: count(raw.messages), lastMessage: text(raw.lastMessage, 1500),
    failed: (Array.isArray(raw.failed) ? raw.failed : []).slice(0, 10).map(entry => ({
      program: text((entry as Record<string, unknown>)?.program, 40).replace(/[^A-Za-z0-9._+-]/g, '') || '?',
      exitCode: Number.isSafeInteger((entry as Record<string, unknown>)?.exitCode) ? Number((entry as Record<string, unknown>).exitCode) : -1 })),
    errors: (Array.isArray(raw.errors) ? raw.errors : []).slice(0, 5).map(entry => text(entry, 300)),
  };
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const safeBranch = (value: string) => BRANCH.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/');

export async function executeCodexWorker(input: {
  worker: Pick<Worker, 'run' | 'workspace'>; compiled: CompiledConfiguration; endpoint: string; token: string;
  task: PipelineTask;
  /** The task branch the agent creates and pushes. */
  branch: string;
  /** Branch to start from; the repository's default branch when omitted. */
  base?: string;
  /** Whether the pipeline opens a change request for the pushed work, so the prompt can tell the agent. */
  delivered: boolean;
  author: { name: string; email: string };
  /** From the source host: which remotes the gateway serves, and what else the agent can reach there. */
  access: { remotePrefix: string; gatewayPrefix: string; notes: string };
  /** Dependency installation that ran before the agent, if any. */
  setup?: { label: string; exitCode: number };
  timeoutMs: number;
}, options: { signal?: AbortSignal } = {}) {
  const endpoint = new URL(input.endpoint);
  if (!/^\/[A-Za-z0-9_/-]+$/.test(input.worker.workspace) || input.worker.workspace.includes('//') || input.worker.workspace.endsWith('/') || endpoint.username || endpoint.password || endpoint.protocol !== 'http:' || !isIPv4(endpoint.hostname) || !endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
    !/^[a-f0-9]{64}$/.test(input.token) || !safeBranch(input.branch) ||
    !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3300000 ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$/.test(input.author.name) || !/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(input.author.email) ||
    !/^https:\/\/[A-Za-z0-9.-]+\/$/.test(input.access.remotePrefix) || !input.access.gatewayPrefix.startsWith(`${input.endpoint}/`) ||
    (input.base !== undefined && !safeBranch(input.base))) throw Error('Invalid worker invocation');
  const config = input.compiled.configuration;
  const branch = input.branch;
  // Mechanism only: where the work goes and what the worker can reach. What to do, and how, is the consumer's instructions.
  const prompt = `${config.instructions}\n\nRepository: ${config.source.repository}\nTask branch: ${branch}\n` +
    (input.base ? `Base branch: ${input.base} (the task branch starts here${input.delivered ? '; your pushed work is opened for review against it after you push' : ''}).\n` : '') +
    (input.setup ? (input.setup.exitCode === 0 ? `Dependencies were installed before you started (${input.setup.label}).`
      : `Dependency installation (${input.setup.label}) failed before you started; its log is ${input.worker.workspace}/user/agent-runtime-setup.log.`) +
      ' The network is now limited to this gateway: you cannot install new packages.\n' : '') +
    `Make and verify the requested changes, then commit and push this task branch. Do not push any other branch or merge.\n` +
    `${input.access.notes}\n\n${input.task.label}: ${input.task.title}\n\n${input.task.body}`;
  const output = await input.worker.run({ command: 'node', args: ['-e', CODEX_WORKER_PROGRAM],
    timeoutMs: input.timeoutMs, maxOutputBytes: 32768,
    ...(options.signal ? { signal: options.signal } : {}),
    input: JSON.stringify({ workspace: input.worker.workspace, endpoint: input.endpoint, token: input.token, version: config.harness.version, model: config.harness.model,
      repository: config.source.repository, branch, prompt, authorName: input.author.name, authorEmail: input.author.email,
      remotePrefix: input.access.remotePrefix, gatewayPrefix: input.access.gatewayPrefix, timeoutMs: input.timeoutMs, ...(input.base ? { base: input.base } : {}) }),
  });
  const result = JSON.parse(output) as Record<string, unknown>;
  if (result.schemaVersion !== 1 || !Number.isSafeInteger(result.exitCode) || (result.exitCode as number) < 0 ||
    !/^[a-f0-9]{40}$/.test(String(result.head)) || typeof result.dirty !== 'boolean' || result.branch !== branch) throw Error('Invalid worker result');
  // Worker output is a claim, not proof of a remote push or task correctness.
  const activity = workerActivity(result.activity);
  return { exitCode: result.exitCode as number, head: String(result.head), dirty: result.dirty, branch, ...(activity ? { activity } : {}) };
}
