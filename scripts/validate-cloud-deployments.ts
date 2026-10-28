import { mkdtempSync, symlinkSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { compileDeployment, writeDeployment } from '../src/deployment/index.js';
import { declaration, infrastructures } from '../test/deployment/fixtures.js';
const cache = process.env.II_PROVIDER_VALIDATION_CACHE;
const parent = mkdtempSync(join(tmpdir(), 'ii-deployment-validation-'));
const results = [];
for (const provider of Object.keys(infrastructures)) {
  const path = join(parent, provider);
  writeDeployment(path, compileDeployment(declaration(provider)));
  if (cache) {
    symlinkSync(resolve(cache, '.terraform'), join(path, '.terraform'));
    copyFileSync(resolve(cache, '.terraform.lock.hcl'), join(path, '.terraform.lock.hcl'));
  } else
    execFileSync('tofu', ['-chdir=' + path, 'init', '-backend=false', '-input=false', '-no-color'], {
      stdio: 'ignore',
    });
  let output: string;
  try {
    output = execFileSync('tofu', ['-chdir=' + path, 'validate', '-json'], { encoding: 'utf8', maxBuffer: 10485760 });
  } catch (error) {
    output = String((error as { stdout: unknown }).stdout);
  }
  const result = JSON.parse(output);
  results.push({ provider, valid: result.valid, diagnostics: result.diagnostics });
  console.log(provider, result.valid ? 'PASS' : JSON.stringify(result.diagnostics));
}
writeFileSync(join(parent, 'results.json'), JSON.stringify(results, null, 2));
console.log('Evidence:', parent);
if (results.some((result) => !result.valid)) process.exitCode = 1;
