import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFactory, type FactoryConfig } from '../src/index.js';
import { WorkStore } from '../src/store.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(),'factory-test-'));
  const config: FactoryConfig = { project: 'example', database: join(directory,'tasks.sqlite'), roles: {
    coder: { kind: 'code', authMode: 'api-key', credentialKey: 'CODEX_KEY', instructions: 'Implement the requested change.', setup: {
      schemaVersion:1, id:'coding',revision:'1',harness:{name:'codex',version:'0.156.1'},
      deployment:{provider: 'tart', options: factoryTartOptions(),image:`registry.example/base@sha256:${'a'.repeat(64)}`,cpu:2,memoryMiB:2048},secrets:[{provider:'github',repository:'org/repo',key:'CODEX_KEY'}],capture:{paths:['candidate.bundle']},
    } },
  } };
  return { config, dispose() { rmSync(directory,{recursive:true}); } };
}
const request = (task: string) => ({ role: 'coder', task, repository: 'org/repo', baseCommit: 'a'.repeat(40) });

test('one-line submissions preserve distinct agents and idempotent retries across restart', () => {
  const f = fixture(); let factory = createFactory(f.config);
  try {
    const a = factory.spawn('first',request('Implement A'));
    const b = factory.spawn('second',request('Implement B'));
    assert.notEqual(a.id,b.id); assert.equal(a.status(),'queued');
    assert.equal(factory.spawn('first',request('Implement A')).id,a.id);
    assert.throws(()=>factory.spawn('first',request('Changed')),/different inputs/);
    factory.close(); factory=createFactory(f.config);
    assert.equal(factory.spawn('first',request('Implement A')).id,a.id);
    assert.equal(factory.agent(b.id).status(),'queued');
  } finally { factory.close(); f.dispose(); }
});

test('roles are validated and snapshotted before later caller mutations', () => {
  const f=fixture();const factory=createFactory(f.config);const store=new WorkStore(f.config.database);
  try {
    f.config.roles.coder!.instructions='changed after initialization';
    assert.throws(()=>factory.spawn('bad',{...request('Task'),role:'missing'}),/Unknown role/);
    const a=factory.spawn('valid',request('Task'));
    assert.equal(JSON.parse(store.get(a.id).input).role.instructions,'Implement the requested change.');
    const other=createFactory({...f.config,project:'other'});
    try { assert.throws(()=>other.agent(a.id),/different project/); } finally {other.close();}
  } finally {store.close();factory.close();f.dispose();}
});

test('cancellation before claim dispatches no attempt; during work it wins over late success', async () => {
  const f=fixture();const factory=createFactory(f.config);const store=new WorkStore(f.config.database);
  try {
    const a=factory.spawn('queued',request('Task'));a.cancel();
    assert.equal(store.claim(a.id),null);assert.equal(a.status(),'cancelled');
    const b=factory.spawn('running',request('Task'));
    const attempt=store.claim(b.id);assert.ok(attempt);b.cancel();assert.equal(b.status(),'running');
    store.finish(attempt,'succeeded',{report:'late'});assert.equal(b.status(),'cancelled');
    await assert.rejects(b.result(),/cancelled/);
  } finally {store.close();factory.close();f.dispose();}
});

test('attempt identities differ on retry, stale completion is rejected, and retained results survive reopen', async () => {
  const f=fixture();const factory=createFactory(f.config);let store=new WorkStore(f.config.database);
  try {
    const a=factory.spawn('agent',request('Task'));
    const first=store.claim(a.id);assert.ok(first);store.finish(first,'retry',{reason:'transient'});
    const second=store.claim(a.id);assert.ok(second);assert.notEqual(first,second);
    assert.throws(()=>store.finish(first,'succeeded',{}),/not active/);
    store.finish(second,'succeeded',{report:'durable'});store.close();store=new WorkStore(f.config.database);
    assert.deepEqual(store.get(a.id).result,{report:'durable'});assert.deepEqual(await a.result(),{report:'durable'});
  } finally {store.close();factory.close();f.dispose();}
});

test('competing processes submit once and only one process claims the task', async () => {
  const f=fixture();const store=new WorkStore(f.config.database);store.close();
  try {
    const moduleUrl=new URL('../src/store.ts',import.meta.url).href;
    const source=`import { WorkStore } from ${JSON.stringify(moduleUrl)}; const s=new WorkStore(process.argv[1]);const t=s.submit('example','same',{task:'Task'});const a=s.claim(t.id);s.close();console.log(JSON.stringify({id:t.id,attempt:a}));`;
    const results=await Promise.all(Array.from({length:4},()=>promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',source,f.config.database])));
    const values=results.map(result=>JSON.parse(result.stdout));
    assert.equal(new Set(values.map(v=>v.id)).size,1);assert.equal(values.filter(v=>v.attempt!==null).length,1);
  } finally {f.dispose();}
});


test('coding roles require a retained candidate bundle before accepting submissions', () => {
  const f = fixture();
  try {
    f.config.roles.coder!.setup.capture.paths = [];
    assert.throws(() => createFactory(f.config), /candidate.bundle/);
    f.config.roles.coder!.setup.capture.paths = ['candidate.bundle'];
    const factory = createFactory(f.config);
    try {
      assert.throws(() => factory.spawn('missing-base', { role: 'coder', task: 'Fix' }), /exact base commit/);
      assert.equal(factory.spawn('code', { role: 'coder', task: 'Fix', repository: 'org/repo', baseCommit: 'a'.repeat(40) }).status(), 'queued');
    } finally { factory.close(); }
  } finally { f.dispose(); }
});

test('role credential bindings require a declared secret and survive caller mutation',()=>{
  const f=fixture();const role=f.config.roles.coder!;
  try{
    role.credentialKey='CODEX_RESEARCH_AUTH';
    assert.throws(()=>createFactory(f.config),/exactly one declared reference/);
    role.setup.secrets=[{provider:'github',repository:'org/repo',key:'CODEX_RESEARCH_AUTH'}];
    const factory=createFactory(f.config);const store=new WorkStore(f.config.database);
    try{
      role.credentialKey='CODEX_OTHER_AUTH';role.setup.secrets[0]!.key='CODEX_OTHER_AUTH';
      const agent=factory.spawn('coding',request('Implement'));
      const saved=JSON.parse(store.get(agent.id).input).role;
      assert.equal(saved.credentialKey,'CODEX_RESEARCH_AUTH');assert.equal(saved.setup.secrets[0].key,'CODEX_RESEARCH_AUTH');
    }finally{store.close();factory.close();}
    role.credentialKey='invalid-key';assert.throws(()=>createFactory(f.config),/Invalid Codex API-key name/);
  }finally{f.dispose();}
});

test('API-key role keeps its auth binding and permission purpose across submission', () => {
  const f = fixture(); const role = f.config.roles.coder!;
  role.authMode = 'api-key'; role.credentialKey = 'CODEX_RESEARCH_API_KEY';
  try {
    assert.throws(() => createFactory(f.config), /exactly one declared reference/);
    role.setup.secrets = [{ provider: 'github', repository: 'org/repo', key: 'CODEX_RESEARCH_API_KEY' }];
    const factory = createFactory(f.config); const store = new WorkStore(f.config.database);
    try {
      const agent = factory.spawn('api-coding', request('Implement'));
      assert.equal(JSON.parse(store.get(agent.id).input).role.authMode, 'api-key');
      assert.equal(agent.permissions().secrets[0]?.purpose, 'harness-auth');
    } finally { store.close(); factory.close(); }
  } finally { f.dispose(); }
});

test('permission inventory keeps fixed harness auth and snapshots GitHub policy', () => {
  const f = fixture(); const role = f.config.roles.coder!;
  role.credentialKey = 'CODEX_RESEARCH_AUTH';
  role.setup.secrets = [{ provider: 'github', repository: 'org/repo', key: 'CODEX_RESEARCH_AUTH' }];
  role.githubPermissions = { issues: 'read' };
  let factory = createFactory(f.config);
  try {
    const agent = factory.spawn('coding', request('Implement')); const saved = agent.permissions();
    assert.equal(saved.evidence, 'declared'); assert.equal(saved.secrets.find(secret => secret.environmentVariable === 'CODEX_RESEARCH_AUTH')!.purpose, 'harness-auth');
    assert.deepEqual(saved.githubPermissions, { issues: 'read' });
    assert.deepEqual(factory.permissions().coder, saved);
    const inventory = factory.permissions(); inventory.coder!.secrets[0]!.reference.key = 'MUTATED';
    assert.deepEqual(agent.permissions(), saved);
    role.githubPermissions = { issues: 'write' }; role.setup.revision = '2';
    factory.close(); factory = createFactory(f.config);
    assert.deepEqual(factory.permissions().coder!.githubPermissions, { issues: 'write' });
    assert.deepEqual(factory.agent(agent.id).permissions(), saved);
    assert.equal(factory.permissions().coder!.setupDigest, saved.setupDigest);
    assert.notDeepEqual(factory.permissions().coder!.githubPermissions, saved.githubPermissions);
    assert.equal(Object.hasOwn(saved, 'instructions'), false);
  } finally { factory.close(); f.dispose(); }
});
