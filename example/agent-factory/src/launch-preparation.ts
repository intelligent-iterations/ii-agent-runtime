import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { prepareAgentSources, type RepositoryAcquisition } from './agent-preparation.js';
import { parseAgentManifest } from './agent-manifest.js';
import { validateAcceptanceChecks, type AcceptanceCheck } from './code-verifier.js';
import type { Setup } from '@intelligent-iterations/ii-agent-runtime';

/** Select commands from the trusted base; never run repository code on the controller host. */
export function repositoryAcceptance(checkout: string, explicit?: string): AcceptanceCheck[] {
  let script: string;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !explicit.trim()) throw Error('verify must be a nonempty shell command');
    script = explicit;
  } else if (existsSync(join(checkout, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
    const command = pkg.scripts?.test;
    if (typeof command !== 'string' || !command.trim() || /no test specified/i.test(command)) throw Error('No test command found; add verify to this agent');
    const hasDependencies = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
    const locked = existsSync(join(checkout, 'package-lock.json'));
    if (hasDependencies && !locked) throw Error('Automatic npm verification requires package-lock.json; add verify to select another command');
    script = (locked ? 'npm ci --ignore-scripts --no-audit --no-fund\n' : '') + 'npm test';
  } else if (existsSync(join(checkout, 'tests')) && readdirSync(join(checkout, 'tests')).some(name => /^test_.*\.py$/.test(name)) &&
      !existsSync(join(checkout, 'pyproject.toml')) && !existsSync(join(checkout, 'requirements.txt'))) {
    script = "python3 - <<'FACTORY_TESTS'\nimport sys, unittest\nsuite = unittest.defaultTestLoader.discover('tests')\nif suite.countTestCases() == 0: raise SystemExit('No unittest cases found; configure verify explicitly')\nresult = unittest.TextTestRunner(verbosity=2).run(suite)\nsys.exit(0 if result.wasSuccessful() else 1)\nFACTORY_TESTS";
  } else throw Error('No supported test command found; add verify to this agent (for example, verify: "make test")');
  const checks = [{ id: 'repository-tests', interpreter: '/bin/sh', script: 'set -eu\n' + script, timeoutMs: 300_000 }];
  validateAcceptanceChecks(checks);
  return checks;
}

export async function prepareLaunchManifest(source: string, options: {
  directory: string; workflowRepository: string; codexSecret: string; baseSetup: Setup; acquire?: RepositoryAcquisition;
}) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw Error('Invalid agent YAML');
  const input = document.toJS({ maxAliasCount: 0 });
  if (!Array.isArray(input?.agents)) throw Error('Agent YAML needs an agents list');
  const commands = new Map<string, string>();
  for (const agent of input.agents) {
    if (agent.verify !== undefined) {
      if (typeof agent.verify !== 'string' || !agent.verify.trim()) throw Error('verify must be a nonempty shell command');
      commands.set(agent.name, agent.verify); delete agent.verify;
    }
  }
  const resolved = await prepareAgentSources(stringify(input), options);
  const manifest = parseAgentManifest(resolved, { directory: options.directory, workflowRepository: options.workflowRepository, baseSetup: options.baseSetup });
  const acceptanceChecksByAgent: Record<string, AcceptanceCheck[]> = {};
  for (const agent of manifest.agents) {
    try { acceptanceChecksByAgent[agent.name] = repositoryAcceptance(agent.checkout!, commands.get(agent.name)); }
    catch (error) { throw Error(`Agent ${agent.name}: ${(error as Error).message}`); }
  }
  return { resolved, manifest, acceptanceChecksByAgent };
}
