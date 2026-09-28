import { createHash } from 'node:crypto';
import { workloadDigest } from './workload-identity.js';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '@intelligent-iterations/ii-agent-runtime';
import { executeGuest } from './guest-transport.js';
import type { ExecutionContext } from './local-coordinator.js';
import type { WorkerInput } from './worker.js';

export interface WorkerBundle { files: Record<string, string>; sha256: string }
/** Package built JS and locked runtime dependencies; no source checkout, credentials or host configuration. */
export function buildWorkerBundle(packageRoot = fileURLToPath(new URL('../', import.meta.url))): WorkerBundle {
  const files: Record<string, string> = {};
  const add = (path: string, name: string) => { files[name] = readFileSync(path).toString('base64'); };
  for (const name of ['telemetry.js', 'worker.js', 'role-credentials.js', 'worker-entry.js', 'workload-identity.js', 'code-candidate.js', 'candidate-links.js', 'code-verifier.js', 'verification-entry.js']) add(join(packageRoot, 'dist', name), `dist/${name}`);
  files['package.json'] = Buffer.from('{"type":"module"}').toString('base64');
  files['worker.mjs'] = Buffer.from("import './dist/worker-entry.js';\n").toString('base64');
  const visited = new Set<string>();
  function dependency(name: string, from: string) {
    if (visited.has(name)) return;
    if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name)) throw Error('Invalid dependency name');
    const require = createRequire(join(from, 'package.json'));
    let root = dirname(name === '@intelligent-iterations/ii-agent-runtime' ? fileURLToPath(import.meta.resolve(name)) : require.resolve(name));
    while (!existsSync(join(root, 'package.json'))) {
      const parent = dirname(root); if (parent === root) throw Error('Dependency manifest missing'); root = parent;
    }
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (manifest.name !== name) throw Error('Dependency identity mismatch');
    visited.add(name);
    function walk(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const path = join(directory, entry.name);
        if (lstatSync(path).isSymbolicLink()) throw Error('Dependency symlink is unsupported');
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && (/\.(js|cjs|mjs|json)$/.test(entry.name) || /^(LICENSE|NOTICE|TELEMETRY_LICENSE)$/.test(entry.name))) {
          add(path, `node_modules/${name}/${relative(root, path).split('\\').join('/')}`);
        }
      }
    }
    if (name === '@intelligent-iterations/ii-agent-runtime') {
      add(join(root, 'package.json'), `node_modules/${name}/package.json`);
      for (const entry of ['dist', 'schemas', 'modules']) walk(join(root, entry));
      for (const entry of ['LICENSE', 'NOTICE', 'TELEMETRY_LICENSE', 'telemetry-import.json']) {
        add(join(root, entry), `node_modules/${name}/${entry}`);
      }
    } else walk(root);
    for (const child of Object.keys(manifest.dependencies ?? {})) dependency(child, root);
  }
  dependency('@intelligent-iterations/ii-agent-runtime', packageRoot);
  return { files, sha256: createHash('sha256').update(canonicalJson(files)).digest('hex') };
}

const stage = `import sys,json,os,base64,hashlib
payload=json.load(sys.stdin)
parent='/opt/factory'
if os.path.islink(parent) or not os.path.isdir(parent): raise ValueError('invalid staging parent')
os.chown(parent,0,0);os.chmod(parent,0o555)
root=parent+'/workload'
os.mkdir(root,0o755)
for name,data in payload['files'].items():
    parts=name.split('/')
    if any(p in ('','..','.') for p in parts) or name.startswith('/') or '\\\\' in name: raise ValueError('invalid path')
    path=os.path.join(root,*parts)
    os.makedirs(os.path.dirname(path),mode=0o755,exist_ok=True)
    decoded=base64.b64decode(data,validate=True)
    with open(path,'xb') as output: output.write(decoded);output.flush();os.fsync(output.fileno())
    os.chmod(path,0o444)
for directory,dirs,files in os.walk(root,topdown=False): os.chown(directory,0,0);os.chmod(directory,0o555)
actual={name:base64.b64encode(open(os.path.join(root,name),'rb').read()).decode('ascii') for name in payload['files']}
digest=hashlib.sha256(json.dumps(actual,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf8')).hexdigest()
print(json.dumps({'files':len(payload['files']),'sha256':digest}))
`;

export type SourceBundleProvider = (context: ExecutionContext) => Promise<{ path: string; sha256: string } | null>;
export type AgentGrantProvider = (context: ExecutionContext) => Promise<{ token: string; delivered(): void } | null>;
const stageAgentToken = `import os,pwd,sys
p='/run/factory-agent-github-token'
account=pwd.getpwnam('agent')
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try:
    os.fchown(fd,account.pw_uid,account.pw_gid)
    data=sys.stdin.buffer.read()
    if not data or len(data)>4096: raise ValueError('invalid token length')
    os.write(fd,data);os.fsync(fd)
finally: os.close(fd)
print('ready')
`;
export function createGuestStager(bundle: WorkerBundle, workflowCommit: string, execute = executeGuest,
  sourceBundle?: SourceBundleProvider, agentGrant?: AgentGrantProvider) {
  if (!/^[a-f0-9]{40}$/.test(workflowCommit) || createHash('sha256').update(canonicalJson(bundle.files)).digest('hex') !== bundle.sha256) throw Error('Invalid worker bundle');
  const files = { ...bundle.files };
  return async (context: ExecutionContext, resource: { manifestPath: string }) => {
    if (context.record('workerStaging')) throw Error('Worker staging already attempted; reconcile instead of overwriting');
    const input = { ...JSON.parse(context.task.input), executionId: context.task.id, attemptId: context.attemptId } as WorkerInput;
    delete input.sourceBundle;
    input.secretTransport = 'indexed';
    const sourceFiles: Record<string, string> = {};
    if (sourceBundle && input.role.kind === 'code') {
      const source = await sourceBundle(context);
      if (source) {
      const stat = lstatSync(source.path);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(source.sha256)) throw Error('Invalid source bundle');
      const bytes = readFileSync(source.path);
      if (bytes.length !== stat.size || createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw Error('Source bundle changed');
      input.sourceBundle = { sha256: source.sha256, size: bytes.length };
      sourceFiles['source.bundle'] = bytes.toString('base64');
      }
    }
    const digest = workloadDigest({ ...input }, bundle.sha256, workflowCommit);
    const envelope = { attemptId: context.attemptId, workflowCommit, bundleDigest: bundle.sha256, workloadDigest: digest, input };
    const staged = { ...files, ...sourceFiles, 'attempt.json': Buffer.from(canonicalJson(envelope)).toString('base64') };
    context.checkpoint('workerStaging', { bundleDigest: bundle.sha256, workflowCommit, workloadDigest: digest, state: 'started' });
    const response = JSON.parse(await execute(resource.manifestPath, ['sudo', '-n', 'python3', '-c', stage], JSON.stringify({ files: staged })));
    if (response.files !== Object.keys(staged).length || response.sha256 !== createHash('sha256').update(canonicalJson(staged)).digest('hex')) throw Error('Worker staging unconfirmed');
    if (agentGrant && Object.keys(input.role.githubPermissions ?? {}).length) {
      const grant = await agentGrant(context);
      if (!grant) throw Error('Required agent GitHub grant unavailable');
      const receipt = await execute(resource.manifestPath, ['sudo', '-n', 'python3', '-c', stageAgentToken], grant.token);
      if (receipt.trim() !== 'ready') throw Error('Agent token delivery unconfirmed');
      grant.delivered();
    }
    context.checkpoint('workerStaging', { bundleDigest: bundle.sha256, workflowCommit, workloadDigest: digest, state: 'complete' });
  };
}
