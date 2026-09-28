import { createLibvirtVM, removeLibvirtVM } from './libvirt.js';
const [operation, manifest] = process.argv.slice(2);
if (!manifest || !['create', 'remove'].includes(operation ?? '')) throw Error('Expected create/remove and manifest path');
try {
  const result = operation === 'create' ? await createLibvirtVM(manifest) : await removeLibvirtVM(manifest);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('VM operation incomplete; reconcile retained deployment before retrying\n');
  process.exitCode = 1;
}
