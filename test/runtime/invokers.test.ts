import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeInvocations, type InvocationCatalog } from '../../src/runtime/invokers.js';
import { compileConfiguration, compileConfigurationText } from '../../src/runtime/configuration.js';
import { stringify } from 'yaml';
import { fixture } from '../runtime-fixture.js';

function catalog(): InvocationCatalog {
  return {
    agents: [
      { id: 'mail', invokers: [{ id: 'inbox', event: 'mail.received', match: { mailbox: ['assistant'] } }] },
      { id: 'factory', invokers: [{ id: 'issue', event: 'issue.created', match: { repository: ['org/project'], label: ['agent-task'] } }] },
    ],
    tools: [
      { name: 'create-issue', effects: [{ event: 'issue.created', fields: { repository: { input: 'repository' }, label: { input: 'label' } } }] },
      { name: 'write-code', effects: [] },
    ],
    grants: [
      { subject: 'mail', tool: 'create-issue', resources: { repository: ['org/project'] }, arguments: { label: ['agent-task'] } },
      { subject: 'factory', tool: 'write-code', resources: { repository: ['org/project'] }, arguments: { branch: ['agent/work'] } },
    ],
  };
}
test('mail → issue → factory preserves authority constraints and leaves input untouched', () => {
  const input = catalog();
  const before = JSON.stringify(input);
  const report = analyzeInvocations(input);
  assert.equal(report.basis, 'user-declared');
  assert.equal(report.exhaustive, false);
  assert.equal(report.truncated, false);
  assert.equal(report.warnings.length, 1);
  assert.equal(report.warnings[0]!.status, 'declared');
  assert.deepEqual(report.warnings[0]!.capability, input.grants[1]);
  assert.equal(report.warnings[0]!.path[0]!.invoker, 'issue');
  assert.equal(JSON.stringify(input), before);
});
test('disjoint resources and arguments never create a path; grant clauses stay separate', () => {
  const input = catalog();
  input.grants = [
    { ...input.grants[0]!, resources: { repository: ['other/project'] } },
    { ...input.grants[0]!, arguments: { label: ['unrelated'] } },
    input.grants[1]!,
  ];
  assert.deepEqual(analyzeInvocations(input).edges, []);
});
test('missing event fields, unconstrained inputs and missing effects remain unknown', () => {
  const input = catalog();
  input.grants[0]!.arguments = {};
  let report = analyzeInvocations(input);
  assert.equal(report.warnings[0]!.status, 'unknown');
  assert.deepEqual(report.edges[0]!.unknownFields, ['label']);
  input.tools = [{ name: 'create-issue', effects: [{ event: 'issue.created', fields: {} }] }, { name: 'write-code' }];
  report = analyzeInvocations(input);
  assert.equal(report.edges[0]!.status, 'unknown');
  assert.deepEqual(report.unknownEffects, [{ subject: 'factory', tool: 'write-code' }]);
});
test('fixed event fields match and conditions survive every hop and destination grant', () => {
  const input = catalog();
  input.tools[0]!.effects = [{ event: 'issue.created', fields: { repository: { values: ['org/project'] }, label: { values: ['agent-task'] } } }];
  input.agents[1]!.invokers[0]!.conditions = ['approved-author'];
  input.grants[0]!.conditions = ['send-approval'];
  input.grants[1]!.conditions = ['write-approval'];
  const report = analyzeInvocations(input);
  assert.equal(report.warnings[0]!.status, 'conditional');
  assert.deepEqual(report.warnings[0]!.conditions, ['send-approval', 'approved-author', 'write-approval']);
});
test('multi-hop paths and cycles terminate without dropping gates', () => {
  const input = catalog();
  input.tools[1]!.effects = [{ event: 'mail.received', fields: { mailbox: { values: ['assistant'] } } }];
  input.grants[1]!.conditions = ['approval'];
  const report = analyzeInvocations(input);
  assert.equal(report.truncated, false);
  const roundTrip = report.warnings.find(w => w.caller === 'mail' && w.callee === 'mail');
  assert.equal(roundTrip!.path.length, 2);
  assert.equal(roundTrip!.status, 'conditional');
  assert.deepEqual(roundTrip!.conditions, ['approval']);
});
test('one input cannot simultaneously satisfy disjoint event field constraints', () => {
  const input = catalog();
  input.tools[0]!.effects = [{ event: 'issue.created', fields: { repository: { input: 'repository' }, label: { input: 'repository' } } }];
  assert.deepEqual(analyzeInvocations(input).edges, []);
});
test('strict schema rejects invalid declarations, references, duplicate ids and ambiguous inputs', () => {
  for (const mutate of [
    (x: any) => { x.agents[0].invokers[0].typo = true; },
    (x: any) => { x.agents[0].invokers[0].match.mailbox = []; },
    (x: any) => { x.tools.push(x.tools[0]); },
    (x: any) => { x.grants[0].subject = 'missing'; },
    (x: any) => { x.grants[0].arguments.repository = ['org/project']; },
    (x: any) => { x.tools[0].effects[0].fields.repository = { input: 'repository', values: ['x'] }; },
  ]) {
    const input = catalog(); mutate(input);
    assert.throws(() => analyzeInvocations(input));
  }
});
test('bounded traversal explicitly reports incomplete output', () => {
  const input = catalog();
  input.agents = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, invokers: [{ id: 'event', event: 'ping', match: {} }] }));
  input.tools = [{ name: 'ping', effects: [{ event: 'ping', fields: {} }] }];
  input.grants = input.agents.map(agent => ({ subject: agent.id, tool: 'ping', resources: {}, arguments: {} }));
  const report = analyzeInvocations(input);
  assert.equal(report.truncated, true);
  assert.ok(report.warnings.length <= 4096);
});
test('invokers round-trip JSON/YAML, affect configuration identity and reject unsupported fields', () => {
  const input = { ...fixture(), invokers: catalog().agents[1]!.invokers };
  const compiled = compileConfiguration(input);
  assert.deepEqual(compiled.configuration.invokers, input.invokers);
  assert.equal(compileConfigurationText(stringify(input), 'yaml').setupDigest, compiled.setupDigest);
  assert.notEqual(compileConfiguration(fixture()).setupDigest, compiled.setupDigest);
  assert.throws(() => compileConfiguration({ ...input, invokers: [{ ...input.invokers[0], handler: 'code' }] }));
});

test('a three-agent path retains the final scope and intermediate gate', () => {
  const input = catalog();
  input.agents = [...input.agents, { id: 'release', invokers: [{ id: 'publish', event: 'code.written', match: {}, conditions: ['review'] }] }];
  input.tools[1]!.effects = [{ event: 'code.written', fields: {} }];
  input.tools = [...input.tools, { name: 'publish', effects: [] }];
  input.grants = [...input.grants, { subject: 'release', tool: 'publish', resources: { repository: ['org/release'] }, arguments: {} }];
  const report = analyzeInvocations(input);
  const warning = report.warnings.find(item => item.caller === 'mail' && item.callee === 'release')!;
  assert.equal(warning.path.length, 2);
  assert.equal(warning.status, 'conditional');
  assert.deepEqual(warning.capability.resources, { repository: ['org/release'] });
  assert.match(warning.message, /requires review/);
  assert.deepEqual(report.directGrants, input.grants);
});
