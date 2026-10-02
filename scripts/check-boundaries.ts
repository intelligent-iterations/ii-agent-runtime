import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Positive dependency allowlist: new dependencies require an explicit boundary review. */
export function importViolations(source: string, filename: string, root: string): string[] {
  const violations: string[] = [];
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const check = (node: ts.Node | undefined) => {
    if (!node || !ts.isStringLiteralLike(node)) { violations.push('Computed module loading is unsupported'); return; }
    const specifier = node.text;
    if (specifier.startsWith('node:') || ['ajv', 'yaml', 'libsodium-wrappers'].includes(specifier)) return;
    if (specifier.startsWith('.')) {
      const target = resolve(filename, '..', specifier);
      const rel = relative(root, target);
      if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)) return;
    }
    violations.push(`Disallowed dependency: ${specifier}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) check(node.moduleSpecifier);
    }
    if (ts.isImportEqualsDeclaration(node)) violations.push('Import assignment is unsupported');
    if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) check(node.argument.literal);
      else violations.push('Computed import type is unsupported');
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && ['require', 'createRequire', 'eval'].includes(node.expression.text)))) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(file) === 'require') check(node.arguments[0]);
      else violations.push('Indirect code loading is unsupported');
    }
    ts.forEachChild(node, visit);
  };
  visit(file); return violations;
}
export function checkBoundaries(root: string): string[] {
  const errors: string[] = [];
  const sourceRoot = resolve(root, 'src');
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) errors.push(`Source symlink is unsupported: ${path}`);
      else if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) errors.push(...importViolations(readFileSync(path, 'utf8'), path, sourceRoot).map(e => `${path}: ${e}`));
    }
  };
  walk(sourceRoot);
  // The neutral core (runtime contracts and pipeline stages) depends on no provider adapter. Only the composition root
  // and the package's front doors, which select or re-export adapters, may.
  const providers = resolve(sourceRoot, 'providers');
  const adapterAware = new Set(['pipeline/create-pipeline.ts', 'pipeline/index.ts', 'index.ts'].map(path => resolve(sourceRoot, path)));
  for (const directory of [resolve(sourceRoot, 'runtime'), resolve(sourceRoot, 'pipeline')]) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (!entry.name.endsWith('.ts') || adapterAware.has(path)) continue;
      const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      file.forEachChild(function visit(node: ts.Node) {
        const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
        if (specifier?.startsWith('.') && !relative(providers, resolve(path, '..', specifier)).startsWith('..')) errors.push(`${path}: the neutral core must not import the adapter ${specifier}`);
        ts.forEachChild(node, visit);
      });
    }
  }
  // The runtime's own tests exercise the runtime only; consumers such as the Software Factory test themselves.
  const example = resolve(root, 'example');
  const testRoot = resolve(root, 'test');
  const scanTests = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) scanTests(path);
      else if (entry.name.endsWith('.ts')) {
        const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
        file.forEachChild(function visit(node: ts.Node) {
          const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
          if (specifier?.startsWith('.') && !relative(example, resolve(path, '..', specifier)).startsWith('..')) errors.push(`${path}: runtime tests must not import ${specifier}`);
          ts.forEachChild(node, visit);
        });
      }
    }
  };
  scanTests(testRoot);
  // The runtime names none of its consumers or their products; each passes its identity in (see src/runtime/consumer.ts).
  // "Hub" is the Software Factory's name for its control repository, so it stays out of the runtime too.
  // Recorded provider captures (test/fixtures) keep their provenance verbatim.
  const fixtures = resolve(testRoot, 'fixtures');
  const scanNames = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { if (path !== fixtures) scanNames(path); }
      else if (/\.(ts|tf|json)$/.test(entry.name)) {
        const text = readFileSync(path, 'utf8');
        if (/factory/i.test(text)) errors.push(`${path}: the runtime must not name the Software Factory or its secrets`);
        if (/\bhubs?\b|\bhub[A-Z_-]|[a-z]Hub(?!ub)/.test(text.replace(/[Gg]it[Hh]ub/g, ''))) errors.push(`${path}: "hub" is a consumer's concept, not the runtime's`);
      }
    }
  };
  for (const directory of [sourceRoot, resolve(root, 'modules'), resolve(root, 'schemas'), testRoot]) scanNames(directory);
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) if (!['ajv', 'yaml', 'libsodium-wrappers'].includes(name)) errors.push(`Unreviewed runtime dependency: ${name}`);
  }
  if (manifest.dependencies?.yaml !== '2.9.1') errors.push('Runtime YAML parser must retain its reviewed exact pin');
  if (manifest.dependencies?.['libsodium-wrappers'] !== '0.8.4') errors.push('GitHub sealed-box adapter must retain its reviewed exact libsodium pin');
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkBoundaries(resolve(import.meta.dirname, '..'));
  if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
  else process.stdout.write('Runtime dependency boundary passed\n');
}
