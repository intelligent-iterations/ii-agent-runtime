import { createTartVM, removeTartVM } from './tart.js';
const [operation, manifest] = process.argv.slice(2);
if (!manifest || !['create', 'remove'].includes(operation ?? '')) throw new Error('Expected create/remove and manifest path');
try {
  const result = operation === 'create' ? await createTartVM(manifest) : await removeTartVM(manifest);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('VM operation incomplete; reconcile the retained deployment before retrying\n');
  process.exitCode = 1;
}
