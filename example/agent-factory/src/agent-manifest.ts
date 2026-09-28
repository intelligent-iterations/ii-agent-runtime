import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { parseSetup, type Setup } from '@intelligent-iterations/ii-agent-runtime';
import type { AgentRequest, FactoryConfig, Role } from './index.js';

export interface ConfiguredAgent {
  name: string;
  request: AgentRequest;
  checkout?: string;
  secretNames: string[];
}
export interface AgentManifest {
  maxConcurrentAgents: number;
  roles: FactoryConfig['roles'];
  agents: ConfiguredAgent[];
}
export interface AgentProfile { image?: string; cpu: number; memoryMiB: number; enabled: boolean }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`${label}: unsupported field ${key}`);
}
function required(value: unknown, label: string, limit = 8192): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw Error(`Invalid ${label}`);
  return value;
}
function secretName(value: unknown): string {
  const name = required(value, 'secret name', 255);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || name.startsWith('GITHUB_')) throw Error('Invalid GitHub secret name');
  return name;
}
function profiles(value: unknown): Record<string, AgentProfile> {
  if (value === undefined) return {};
  const configured = object(value, 'Profiles');
  const result: Record<string, AgentProfile> = {};
  for (const [name, raw] of Object.entries(configured)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw Error('Invalid profile name');
    const profile = object(raw, `Profile ${name}`);
    keys(profile, ['image', 'cpu', 'memoryMiB', 'enabled'], `Profile ${name}`);
    const enabled = profile.enabled ?? true;
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(profile.cpu) || (profile.cpu as number) < 1 ||
        !Number.isSafeInteger(profile.memoryMiB) || (profile.memoryMiB as number) < 512 ||
        (enabled && (typeof profile.image !== 'string' || !/^.+@sha256:[a-f0-9]{64}$/.test(profile.image))) ||
        (profile.image !== undefined && (typeof profile.image !== 'string' || !/^.+@sha256:[a-f0-9]{64}$/.test(profile.image)))) throw Error(`Invalid profile ${name}`);
    result[name] = { ...(profile.image === undefined ? {} : { image: profile.image as string }),
      cpu: profile.cpu as number, memoryMiB: profile.memoryMiB as number, enabled };
  }
  return result;
}

/** Strict, data-only manifest. Secret values and executable code are never parsed. */
export function parseAgentManifest(source: string, options: { directory: string; workflowRepository: string; baseSetup: Setup }): AgentManifest {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw Error('Invalid or ambiguous agent YAML');
  const manifest = object(document.toJS({ maxAliasCount: 0 }), 'Manifest');
  keys(manifest, ['schemaVersion', 'maxConcurrentAgents', 'profiles', 'defaults', 'agents'], 'Manifest');
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.agents) || !manifest.agents.length) throw Error('Invalid agent manifest');
  const defaults = manifest.defaults === undefined ? {} : object(manifest.defaults, 'Defaults');
  keys(defaults, ['codexSecret'], 'Defaults');
  const maximum = manifest.maxConcurrentAgents ?? 2;
  if (!Number.isSafeInteger(maximum) || (maximum as number) < 1) throw Error('Invalid agent concurrency');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.workflowRepository)) throw Error('Invalid workflow repository');
  const availableProfiles = profiles(manifest.profiles);
  const roles: Record<string, Role> = {};
  const agents: ConfiguredAgent[] = [];
  for (const raw of manifest.agents) {
    const agent = object(raw, 'Agent');
    keys(agent, ['name', 'prompt', 'instructions', 'repository', 'baseCommit', 'checkout', 'model', 'profile', 'githubPermissions'], 'Agent');
    const name = required(agent.name, 'agent name', 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || Object.hasOwn(roles, name)) throw Error('Duplicate or invalid agent name');
    const prompt = required(agent.prompt, 'agent prompt', 32_768);
    const repository = required(agent.repository, 'source repository', 200);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw Error('Invalid source repository');
    const baseCommit = required(agent.baseCommit, 'base commit', 40);
    if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw Error('Agent requires an exact base commit');
    const codex = secretName(defaults.codexSecret);
    const githubPermissions = agent.githubPermissions === undefined ? undefined : object(agent.githubPermissions, 'GitHub permissions');
    if (githubPermissions && (!Object.keys(githubPermissions).length || Object.entries(githubPermissions).some(([permission, level]) =>
        !/^[a-z_]+$/.test(permission) || !['read', 'write'].includes(String(level))))) throw Error('Invalid agent GitHub permissions');
    const selected = agent.profile === undefined ? undefined : availableProfiles[required(agent.profile, 'profile', 64)];
    if (agent.profile !== undefined && (!selected || !selected.enabled || !selected.image)) throw Error(`Agent ${name} requires an enabled profile with an immutable image`);
    const setup = parseSetup({ ...options.baseSetup, id: name,
      ...(selected ? { deployment: { ...options.baseSetup.deployment, provider: options.baseSetup.deployment.provider, image: selected.image, cpu: selected.cpu, memoryMiB: selected.memoryMiB } } : {}),
      secrets: [{ provider: 'github', repository: options.workflowRepository, key: codex }] });
    const instructions = agent.instructions === undefined ? 'Implement the requested coding task. An independent verifier checks the sealed result.' : required(agent.instructions, 'instructions', 16_384);
    const model = agent.model === undefined ? undefined : required(agent.model, 'model', 160);
    const role: Role = { kind: 'code', instructions, setup, credentialKey: codex, authMode: 'api-key',
      ...(githubPermissions ? { githubPermissions: githubPermissions as Record<string, 'read' | 'write'> } : {}),
      ...(model ? { model } : {}) };
    roles[name] = role;
    const checkout = agent.checkout === undefined ? undefined : resolve(options.directory, required(agent.checkout, 'checkout path', 4096));
    agents.push({ name, request: { role: name, task: prompt, repository, baseCommit }, ...(checkout ? { checkout } : {}), secretNames: setup.secrets.map(reference => reference.key) });
  }
  return { maxConcurrentAgents: maximum as number, roles, agents };
}

export function loadAgentManifest(path: string, options: { workflowRepository: string; baseSetup: Setup }): AgentManifest {
  const location = resolve(path);
  return parseAgentManifest(readFileSync(location, 'utf8'), { ...options, directory: dirname(location) });
}

/** Pin each trusted checkout to immutable bundle bytes before any agent launches. */
export function prepareSourceBundles(manifest: AgentManifest, directory: string): Map<string, { path: string; sha256: string }> {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const result = new Map<string, { path: string; sha256: string }>();
  for (const agent of manifest.agents) {
    if (!agent.checkout) continue;
    const checkout = resolve(agent.checkout);
    const run = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd: checkout, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    }).trim();
    if (run('status', '--porcelain') || run('rev-parse', 'HEAD') !== agent.request.baseCommit) throw Error(`Checkout for ${agent.name} is dirty or at another commit`);
    const temporary = mkdtempSync(join(root, 'bundle-'));
    try {
      const bundle = join(temporary, 'source.bundle');
      run('bundle', 'create', bundle, 'HEAD');
      const bytes = readFileSync(bundle);
      if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw Error('Source bundle is empty or too large');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const path = join(root, `${sha256}.bundle`);
      try { renameSync(bundle, path); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      chmodSync(path, 0o600);
      result.set(agent.name, { path, sha256 });
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  return result;
}
