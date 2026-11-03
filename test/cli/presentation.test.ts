import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPreflightReport } from '../../src/cli/presentation.js';
import type { PreflightReport } from '../../src/runtime/preflight.js';
import { declaration } from '../deployment/fixtures.js';
const cli = (...args: string[]) => spawnSync(process.execPath,
  ['--import', 'tsx', 'src/deployment/cli.ts', ...args], { encoding: 'utf8' });

test('help explains real commands, flags and the validation boundary', () => {
  for (const args of [[], ['--help'], ['apply', '--help']]) {
    const result = cli(...args);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Schema validation is not a security assessment/);
  }
  assert.match(cli('apply', '--help').stdout, /--plan-digest <digest>/);
});
test('usage errors precede filesystem access and infrastructure operations', () => {
  for (const args of [['apply', '/missing'], ['compile', '/missing', '--destroy'],
    ['plan', '/missing', 'extra'], ['validate', '/missing', '--format', 'xml'], ['constructor', '/missing']]) {
    const result = cli(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Error:/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
  const result = cli('apply', '/missing', '--format', 'json');
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENTS');
});
test('compile retains pipe contract and offers readable text without changing artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ii-cli-'));
  try {
    const config = join(root, 'host.json');
    writeFileSync(config, JSON.stringify(declaration('aws')));
    const run = (format: string[]) => cli('compile', config, '--output-directory', join(root, `out-${format.length ? format[1] : 'default'}`), ...format);
    const legacy = run([]);
    const json = run(['--format', 'json']);
    const text = run(['--format', 'text']);
    for (const result of [legacy, json, text]) { assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ''); }
    assert.deepEqual(JSON.parse(legacy.stdout), JSON.parse(json.stdout));
    assert.match(text.stdout, /COMPILED/);
    assert.match(text.stdout, /Next: validate/);
    assert.match(text.stdout, new RegExp(JSON.parse(json.stdout).configurationDigest));
    assert.ok(existsSync(join(root, 'out-text', 'deployment.json')));
    const error = cli('compile', join(root, 'missing'), '--output-directory', join(root, 'no'), '--format', 'json');
    assert.equal(error.status, 1);
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).error.code, 'OPERATION_FAILED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const report: PreflightReport = { configurationDigest: 'sha256:test', evaluatedAt: 1000, expiresAt: 2000,
  coverage: 'partial', exhaustive: false, checks: [{ id: 'example.path', provider: 'github', status: 'finding', severity: 'high',
    summary: 'Potential indirect authority', tools: ['write-file'], path: ['GitHub write', 'Privileged workflow', 'AWS role'],
    evidence: [{ source: 'test fixture', resource: 'repo/.github/workflows/deploy.yml', observedAt: 1000 }],
    limitations: ['IAM effective permissions unverified'] }] };
test('preflight preserves potential findings, evidence and uncertainty without changing the report', () => {
  const before = structuredClone(report);
  const output = formatPreflightReport(report);
  assert.match(output, /FINDINGS REQUIRE REVIEW/);
  assert.match(output, /1\. GitHub write\n    2\. Privileged workflow\n    3\. AWS role/);
  assert.match(output, /IAM effective permissions unverified/);
  assert.match(output, /Source: test fixture/);
  assert.match(output, /does not grant admission/);
  assert.deepEqual(report, before);
  assert.match(formatPreflightReport({ ...report, checks: [] }), /ASSESSMENT INCOMPLETE/);
  assert.match(formatPreflightReport({ ...report, coverage: 'supported-checks-complete', checks: [] }), /NO FINDINGS IN SUPPORTED CHECKS/);
  assert.match(formatPreflightReport({ ...report, coverage: 'supported-checks-complete', checks: [{ ...report.checks[0]!, status: 'unknown' }] }), /ASSESSMENT INCOMPLETE/);
});
test('provider content cannot clear the terminal, forge lines or hide text with bidi controls', () => {
  const output = formatPreflightReport({ ...report, checks: [{ ...report.checks[0]!, summary: '\x1b[2J\nCLEAR\u202e' }] });
  assert.doesNotMatch(output, /\x1b|\u202e/);
  assert.match(output, /\\u001b\[2J\\u000aCLEAR\\u202e/);
});
