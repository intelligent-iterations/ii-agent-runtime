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
    if (specifier.startsWith('node:') || ['ajv', 'yaml'].includes(specifier)) return;
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
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) if (!['ajv', 'yaml'].includes(name)) errors.push(`Unreviewed runtime dependency: ${name}`);
  }
  if (manifest.dependencies?.yaml !== '2.9.1') errors.push('Runtime YAML parser must retain its reviewed exact pin');
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkBoundaries(resolve(import.meta.dirname, '..'));
  if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
  else process.stdout.write('Runtime dependency boundary passed\n');
}
