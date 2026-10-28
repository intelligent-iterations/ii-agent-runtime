import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileDeployment, writeDeployment, applyDeployment, planDeployment } from '../../src/deployment/index.js';
import { declaration, infrastructures } from './fixtures.js';
import { UnsupportedDeployment } from '../../src/deployment/contracts.js';

test('unimplemented hosting providers fail explicitly instead of compiling a forwarding deployment', () => {
  for (const provider of ['cloudflare', 'fastly', 'fly', 'render', 'railway', 'vercel']) {
    const input = declaration(provider);
    input.infrastructure.execution_endpoint = 'https://elsewhere.example/webhook';
    assert.throws(() => compileDeployment(input), (error: unknown) =>
      error instanceof UnsupportedDeployment && error.provider === provider && /no deployment adapter/.test(error.message));
  }
  const input = declaration('aws');
  input.infrastructure.execution_endpoint = 'https://elsewhere.example/webhook';
  assert.throws(() => compileDeployment(input), /execution_endpoint/);
});

for (const provider of Object.keys(infrastructures))
  test(`${provider}: compiles execution host IaC with explicit evidence`, () => {
    const input = declaration(provider),
      artifact = compileDeployment(input);
    assert.equal(artifact.provider, provider);
    assert.equal(artifact.evidence.live, 'not-run');
    const document = JSON.parse(artifact.files['main.tf.json']!);
    assert.ok(Object.keys(document.resource).length);
    assert.ok(
      Object.values(document.terraform.required_providers).every((entry: any) => /^\d+\.\d+\.\d+$/.test(entry.version)),
    );
    assert.equal(compileDeployment(structuredClone(input)).configurationDigest, artifact.configurationDigest);
  });
test('rejects unknown providers and application-specific deployment fields', () => {
  assert.throws(() => compileDeployment(declaration('missing')));
  assert.throws(() => compileDeployment({ ...declaration('aws'), application: { command: ['serve'] } }), /field/);
});
test('provider settings stay literal through Terraform interpolation', () => {
  const input = declaration('aws');
  input.infrastructure.key_name = '${file("/etc/passwd")}';
  const artifact = compileDeployment(input);
  const document = JSON.parse(artifact.files['main.tf.json']!);
  assert.equal(document.resource.aws_instance.host.key_name, '$${file("/etc/passwd")}');
  assert.match(artifact.files['cloud-init.yaml']!, /docker.io/);
});
test('saved plan cannot be applied after the artifact or plan changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ii-deployment-test-')),
    directory = join(root, 'deployment');
  try {
    writeDeployment(directory, compileDeployment(declaration('aws')));
    const calls: string[][] = [];
    const process = async (request: any) => {
      calls.push(request.args);
      if (request.args.includes('plan')) writeFileSync(join(directory, 'deployment.tfplan'), 'saved');
      return '{}';
    };
    const options = { directory, environment: { PATH: '/bin' }, process };
    const receipt = await planDeployment(options);
    writeFileSync(join(directory, 'main.tf.json'), 'changed');
    await assert.rejects(applyDeployment(options, receipt.planDigest), /changed/);
    assert.ok(!calls.some((args) => args.includes('apply')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('previously compiled forwarding deployments cannot invoke infrastructure operations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ii-retired-deployment-'));
  try {
    writeFileSync(join(root, 'deployment.json'), JSON.stringify({
      schemaVersion: 1, activation: 'platform-ingress', files: ['main.tf.json'],
    }));
    let invoked = false;
    const options = { directory: root, environment: {}, process: async () => { invoked = true; return ''; } };
    await assert.rejects(planDeployment(options), /compile an agent-hosting deployment/);
    await assert.rejects(applyDeployment(options, 'old-plan'), /compile an agent-hosting deployment/);
    assert.equal(invoked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
