import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stringify } from 'yaml';
import { compileSetup, compileSetupJson, compileSetupYaml, defineSetup, SetupCompilationError,
  SETUP_SOURCE_MAX_BYTES, withLaunchChecks, LaunchDenied, type Setup } from '../src/index.js';
const source = readFileSync(new URL('./fixtures/authoring-setup.yaml', import.meta.url), 'utf8');
const jsonSource = readFileSync(new URL('./fixtures/authoring-setup.json', import.meta.url), 'utf8');
const golden = JSON.parse(readFileSync(new URL('./fixtures/authoring-golden.json', import.meta.url), 'utf8'));
const fixture = (): Setup => JSON.parse(jsonSource);
const compileAll = (value: Setup) => [compileSetup(value), compileSetup(defineSetup(value)), compileSetupJson(JSON.stringify(value)), compileSetupYaml(stringify(value))];

test('all authoring paths match frozen pre-compiler JSON bytes and digest across every setup field', () => {
  for (const actual of [...compileAll(fixture()), compileSetupYaml(source)]) {
    assert.equal(actual.json, golden.json); assert.equal(actual.digest, golden.digest);
    assert.deepEqual(JSON.parse(actual.json), actual.setup);
  }
  const input = fixture(); const built = defineSetup(input); input.capture.paths.push('changed');
  assert.deepEqual(built.capture.paths, ['a.txt', 'z.txt']);
});

test('formatting, object/set order and revision semantics preserve the existing identity contract', () => {
  const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([k,v]) => [k,reverse(v)])) : value;
  for (let offset = 0; offset < fixture().secrets.length; offset++) {
    const value = reverse(fixture()) as Setup;
    value.secrets.push(...value.secrets.splice(0,offset)); value.capture.paths.reverse();
    for (const actual of compileAll(value)) assert.equal(actual.json, golden.json);
  }
  assert.equal(compileSetupYaml('# comment\n'+source.replace('cpu: 2','cpu: 2 # resources')).json, golden.json);
  const ordered=fixture(); ordered.deployment.options={ordered:['first','second']};
  const before=compileSetup(ordered).digest; (ordered.deployment.options.ordered as string[]).reverse();
  assert.notEqual(compileSetupYaml(stringify(ordered)).digest,before);
  const changed = fixture(); changed.revision = 'r2';
  for (const actual of compileAll(changed)) { assert.notEqual(actual.json, golden.json); assert.equal(actual.digest,golden.digest); }
  const mutations: Array<(value: Setup) => void> = [
    s => { s.id = 'changed'; }, s => { s.harness.name = 'other'; }, s => { s.harness.version = '2'; },
    s => { s.deployment.cpu++; }, s => { s.deployment.memoryMiB++; }, s => { s.deployment.provider = 'other'; },
    s => { s.deployment.image = s.deployment.image.replace('a'.repeat(64),'b'.repeat(64)); },
    s => { s.deployment.options!.os = 'darwin'; },
    s => { (s.deployment.options!.network as {blockCidrs:string[]}).blockCidrs.reverse(); (s.deployment.options!.network as {blockCidrs:string[]}).blockCidrs.push('127.0.0.0/8'); },
    s => { s.secrets[0]!.key = 'OTHER'; }, s => { s.capture.paths.push('other'); },
  ];
  for (const mutate of mutations) { const value=fixture(); mutate(value); const results=compileAll(value);
    assert.notEqual(results[0]!.digest,golden.digest); assert.ok(results.every(r=>r.json===results[0]!.json && r.digest===results[0]!.digest)); }
});

test('YAML rejects ambiguous or executable syntax with locations and without source excerpts', () => {
  const bad = [
    source+'id: synthetic-private-value\n', source.replace('id: authoring','id: &synthetic-private-value authoring'),
    source.replace('id: authoring','id: *synthetic-private-value'), source.replace('id: authoring','id: !synthetic-private-value authoring'),
    source.replace('id: authoring','id: !!str authoring'), source+'---\nsynthetic-private-value: true\n',
    '%YAML 1.1\n---\n'+source, '%TAG !! tag:custom.example,2026:\n---\n'+source, '<<: {synthetic-private-value: true}\n'+source,
    '? [synthetic-private-value]\n: value\n'+source, source.replace('cpu: 2','cpu: 0x2'),
    source.replace('cpu: 2','cpu: .inf'), source.replace('cpu: 2','cpu: 02'),
    source.replace('blockHostAddresses: true','blockHostAddresses: True'),
    'id: "synthetic-private-value\n', source.replace('id: authoring','id:'),
  ];
  for (const [index, input] of bad.entries()) assert.throws(()=>compileSetupYaml(input), error=>{
    assert.ok(error instanceof SetupCompilationError); assert.ok(error.code.startsWith('YAML_'));
    assert.ok(error.line!>0 && error.column!>0); assert.ok(!error.message.includes('synthetic-private-value')); return true;
  }, `YAML case ${index}`);
});

test('equivalent invalid data yields identical schema/semantic errors on every authoring path', () => {
  const bad = [
    {...fixture(), agents:[]}, {...fixture(), prompt:'synthetic-private-value'}, {...fixture(), repository:'org/repo'},
    {...fixture(), secrets:[{...fixture().secrets[0],value:'synthetic-private-value'}]},
    {...fixture(),capture:{paths:['../private']}}, {...fixture(),secrets:[fixture().secrets[0],fixture().secrets[0]]},
    {...fixture(),deployment:{...fixture().deployment,cpu:'2'}},
    {...fixture(),secrets:[{provider:'github',repository:'org/repo',organization:'other',key:'KEY'}]},
  ];
  for (const value of bad) {
    const messages = [()=>compileSetup(value),()=>defineSetup(value as Setup),()=>compileSetupJson(JSON.stringify(value)),()=>compileSetupYaml(stringify(value))].map(run=>{
      try {run(); assert.fail('accepted invalid setup');} catch(error) {assert.ok(error instanceof SetupCompilationError); assert.equal(error.code,'INVALID_SETUP'); assert.ok(!error.message.includes('synthetic-private-value')); return error.message;}
    });
    assert.equal(new Set(messages).size,1);
  }
});

test('builder rejects non-data values without executing getters, proxy traps or toJSON', () => {
  let invoked = false;
  const effect = () => {invoked=true; throw Error('synthetic-private-value');};
  const getter = Object.defineProperty({},'x',{enumerable:true,get:effect});
  const cycle: Record<string,unknown> = {}; cycle.self=cycle;
  const hidden = Object.defineProperty({},'x',{value:1});
  const augmented = [1] as number[] & {x?:number}; augmented.x=2;
  for (const value of [getter,new Proxy({}, {ownKeys:effect}),{toJSON:effect},cycle,hidden,augmented,
    new Date(),new Map(),Object.create(null),{[Symbol('x')]:1},[undefined],Array(2),NaN,Infinity,()=>0,1n]) {
    assert.throws(()=>compileSetup({...fixture(),deployment:{...fixture().deployment,options:{value}}}),SetupCompilationError);
  }
  assert.equal(invoked,false);
});

test('source and object limits are enforced; strings are not interpolated or loaded', () => {
  for (const compile of [compileSetupYaml,compileSetupJson]) assert.throws(()=>compile(' '.repeat(SETUP_SOURCE_MAX_BYTES+1)),/limit/);
  let nested: unknown = 1; for(let i=0;i<70;i++) nested={child:nested};
  for (const compile of [()=>compileSetup(nested),()=>compileSetupJson(JSON.stringify(nested)),()=>compileSetupYaml(JSON.stringify(nested))]) assert.throws(compile,/limit/);
  assert.throws(()=>compileSetup({...fixture(),deployment:{...fixture().deployment,options:{many:Array(50_001).fill(0)}}}),/limit/);
  const value=fixture(); value.deployment.options={literal:'${HOME}',file:'./credentials',strings:['yes','2026-09-27'],number:1e3,boolean:false,nil:null};
  for (const actual of compileAll(value)) assert.deepEqual(actual.setup.deployment.options,value.deployment.options);
});

test('compiled configurations still require fresh launch authorization and metadata evidence', async () => {
  let allow=true; let executions=0; let checks=0;
  const context={subject:'test',authorize:async()=>({status:'verified' as const,evidenceId:'caller'}),inspectSecret:async()=>{checks++;return {status:allow?'verified' as const:'denied' as const,evidenceId:'secret'};}};
  const compiled=compileSetupYaml(source);
  await withLaunchChecks(JSON.parse(compiled.json),context,async()=>{executions++;}); allow=false;
  await assert.rejects(withLaunchChecks(JSON.parse(compiled.json),context,async()=>{executions++;}),LaunchDenied);
  assert.equal(executions,1); assert.equal(checks,8);
});

const cli=(args:string[],input?:string|Buffer,cwd?:string)=>spawnSync(process.execPath,['--import','tsx',resolve('src/cli.ts'),...args],{
  input,encoding:'utf8',...(cwd?{cwd}:{}),env:{...process.env, NODE_OPTIONS:''},timeout:10000,
});
test('compile CLI emits plain canonical JSON for stdin/files and sanitized structured failures', () => {
  for(const [format,input] of [['yaml',source],['json',jsonSource]]) {
    const result=cli(['compile','--format',format!],input); assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,golden.json+'\n'); assert.equal(result.stderr,'');
  }
  const file=cli(['compile','--format','yaml',resolve('test/fixtures/authoring-setup.yaml')]); assert.equal(file.status,0,file.stderr);assert.equal(file.stdout,golden.json+'\n');
  for(const [args,input,code] of [
    [['compile','--format','yaml'],'id: "synthetic-private-value\n','YAML_SYNTAX'],
    [['compile','--format','json'],'{"secret":"synthetic-private-value"','JSON_SYNTAX'],
    [['compile','--format','typescript'],'','USAGE'],
    [['compile','--format','json','/missing/synthetic-private-value'],'','INPUT_READ'],
    [['compile','--format','json'],Buffer.from([0xff]),'INPUT_ENCODING'],
    [['compile','--format','json'],' '.repeat(SETUP_SOURCE_MAX_BYTES+1),'INPUT_LIMIT'],
  ] as const) {const result=cli([...args],input); assert.notEqual(result.status,0);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).error.code,code);assert.ok(!result.stderr.includes('synthetic-private-value'));}
});

test('compilation never evaluates configuration modules or calls provider transports', async () => {
  const dir=mkdtempSync(join(tmpdir(),'runtime-authoring-'));
  try {
    const marker=join(dir,'executed');const file=join(dir,'config.ts');
    writeFileSync(file,`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'executed'); export default {};`);
    const result=cli(['compile','--format','json',file]); assert.notEqual(result.status,0);assert.equal(existsSync(marker),false);
    const fetch=globalThis.fetch; globalThis.fetch=async()=>{assert.fail('compiler used network');};
    try {assert.equal(compileSetupYaml(source).digest,golden.digest);} finally {globalThis.fetch=fetch;}
  } finally {rmSync(dir,{recursive:true,force:true});}
});

// Checked by tsc; the helper accepts the existing typed contract, not factory fields.
function typeContract() {
  defineSetup(fixture());
  // @ts-expect-error resources must be numbers
  defineSetup({...fixture(),deployment:{...fixture().deployment,cpu:'2'}});
  // @ts-expect-error factory prompts are not runtime setup fields
  defineSetup({...fixture(),prompt:'task'});
}
void typeContract;

test('YAML schema and semantic diagnostics identify their source values', () => {
  for (const [input,path,text] of [
    [source.replace('cpu: 2','cpu: "private-value"'),'/deployment/cpu','"private-value"'],
    [source.replace('a.txt','../private-value'),'/capture/paths/1','../private-value'],
  ]) {
    assert.throws(()=>compileSetupYaml(input!),error=>{
      assert.ok(error instanceof SetupCompilationError);
      const issue=error.issues.find(issue=>issue.path===path);
      assert.ok(issue); assert.ok(issue.line); assert.ok(issue.column);
      assert.ok(input!.split('\n')[issue.line-1]!.slice(issue.column-1).startsWith(text!));
      assert.ok(!error.message.includes('private-value')); return true;
    });
  }
});

test('TypeScript builder diagnostics identify the caller without changing configuration identity', () => {
  assert.throws(()=>defineSetup({...fixture(),capture:{paths:['../invalid']}}),error=>{
    assert.ok(error instanceof SetupCompilationError);
    assert.match(error.source!, /authoring.test.ts$/);
    assert.ok(error.line!>0 && error.column!>0);
    assert.equal(error.issues[0]!.path,'/capture/paths/0'); return true;
  });
});
