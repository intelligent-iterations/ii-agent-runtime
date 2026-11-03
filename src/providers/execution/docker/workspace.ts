import { attestRetainedResources, readOwnedJson, verifyRetainedModule } from './retained.js';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessRequest } from '../../shared/process.js';

const helperProgram = `set -eu
operation="$1"; owner="$2"; size="$3"
file=/storage/workspace.ext4
for index in $(seq 0 255); do
  test -e "/dev/loop$index" || mknod "/dev/loop$index" b 7 "$index"
done
associated() { losetup --associated "$file" --noheadings --output NAME; }
case "$operation" in
 create)
  test ! -e /storage/.owner
  (set -C; printf '%s' "$owner" > /storage/.owner)
  test ! -e "$file"
  truncate -s "$size" "$file"
  mkfs.ext4 -q -F -m 0 "$file" >&2
  device=$(losetup --find --show --nooverlap "$file")
  test "$(blockdev --getsize64 "$device")" = "$size"
  mkdir /tmp/workspace
  mounted=0
  trap 'if [ "$mounted" = 1 ]; then umount /tmp/workspace; fi' EXIT
  mount -t ext4 -o nosuid,nodev "$device" /tmp/workspace
  mounted=1
  chmod 0700 /tmp/workspace
  chown 10001:10001 /tmp/workspace
  umount /tmp/workspace
  mounted=0
  printf '{"device":"%s","sizeBytes":%s}\\n' "$device" "$size"
  ;;
 remove)
  if test -e /storage/.owner; then
   test "$(cat /storage/.owner)" = "$owner"
   if test -e "$file"; then
    for device in $(associated); do
     case "$device" in /dev/loop[0-9]*) ;; *) exit 1 ;; esac
     losetup --detach "$device"
    done
    test -z "$(associated)"
   fi
  else
   test -z "$(ls -A /storage)"
  fi
  ;;
 *) exit 2 ;;
esac
`;

/** A bounded ext4 filesystem; its backing volume and worker mounts are IaC-owned. */
export function dockerDiskWorkspace(options: {
  owner: string; directory: string; image: string; resume?: boolean; diskGiB: number; environment: Record<string, string>;
  execute(request: ProcessRequest, cleanup: boolean): Promise<string>;
}) {
  if (!/^[a-f0-9]{32}$/.test(options.owner) || !/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(options.image) ||
      !Number.isInteger(options.diskGiB) || options.diskGiB < 1 || options.diskGiB > 80) throw Error('Invalid disk workspace binding');
  const directory = join(options.directory, 'disk'), name = `ii-disk-${options.owner}`;
  let created = false, initialized = false, applied = false, closed = false;
  let volume: string | undefined;
  if (options.resume) {
    verifyRetainedModule(directory, 'docker-workspace', options.owner);
    const variables = readOwnedJson(directory, 'runtime.auto.tfvars.json');
    if (Object.keys(variables).join(',') !== 'owner' || variables.owner !== options.owner) throw Error('Retained disk binding changed');
    created = true; initialized = true; applied = true;
  }
  const run = (command: string, args: string[], cleanup = false, timeoutMs = 120000) => options.execute({
    command, args, cwd: directory, env: options.environment, timeoutMs, maxOutputBytes: 1048576,
  }, cleanup);
  const owned = () => {
    if (realpathSync(directory) !== directory || readFileSync(join(directory, '.owner'), 'utf8') !== options.owner) throw Error('Disk workspace ownership changed');
  };
  const inspectVolume = async (cleanup: boolean) => {
    const value = JSON.parse(await run('docker', ['volume', 'inspect', volume!], cleanup));
    if (value.length !== 1 || value[0].Name !== volume || value[0].Labels?.['agent-runtime.owner'] !== options.owner || value[0].Driver !== 'local') throw Error('Disk volume ownership changed');
  };
  const helperName = (operation: 'create' | 'remove') => operation === 'create' ? name : name + '-cleanup';
  const inspectHelper = async (operation: 'create' | 'remove') => {
    const ids = (await run('docker', ['ps', '--all', '--quiet', '--filter', `name=^/${helperName(operation)}$`], true)).trim();
    if (!ids) return undefined;
    if (!/^[a-f0-9]{12,64}$/.test(ids)) throw Error('Disk helper identity unconfirmed');
    const inspected = JSON.parse(await run('docker', ['inspect', ids], true));
    const expected = ['-c', helperProgram, 'disk', operation, options.owner, String(options.diskGiB * 1073741824)];
    if (inspected.length !== 1 || inspected[0].Config?.Labels?.['agent-runtime.owner'] !== options.owner ||
        inspected[0].Config?.Image !== options.image || JSON.stringify(inspected[0].Config?.Cmd) !== JSON.stringify(expected) ||
        JSON.stringify(inspected[0].Config?.Entrypoint) !== JSON.stringify(['/bin/sh']) ||
        !inspected[0].Mounts?.some((mount: { Type?: string; Name?: string; Destination?: string }) =>
          mount.Type === 'volume' && mount.Name === volume && mount.Destination === '/storage')) throw Error('Disk helper ownership changed');
    return { id: ids, running: inspected[0].State?.Running === true };
  };
  const helper = async (operation: 'create' | 'remove', cleanup: boolean) => {
    if (operation === 'remove') {
      const existing = await inspectHelper(operation);
      if (existing) {
        if (existing.running) await run('docker', ['stop', '--time', '0', existing.id], true);
        return run('docker', ['start', '--attach', existing.id], true);
      }
    }
    return run('docker', [
    'run', '--name', helperName(operation), '--label', `agent-runtime.owner=${options.owner}`,
    '--cpus', '0.25', '--memory', '256m', '--memory-swap', '256m', '--pids-limit', '32',
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'SYS_ADMIN', '--cap-add', 'MKNOD', '--cap-add', 'CHOWN',
    '--security-opt', 'apparmor=unconfined', '--security-opt', 'no-new-privileges:true',
    '--device', '/dev/loop-control:/dev/loop-control', '--device-cgroup-rule', 'b 7:* rwm',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--mount', `type=volume,source=${volume},target=/storage`,
    '--entrypoint', '/bin/sh', options.image, '-c', helperProgram, 'disk', operation, options.owner, String(options.diskGiB * 1073741824),
  ], cleanup);
  };
  return {
    async create(): Promise<{ device: string; sizeBytes: number }> {
      if (created || closed) throw Error('Disk workspace already used');
      mkdirSync(directory, { mode: 0o700 }); created = true;
      writeFileSync(join(directory, '.owner'), options.owner, { mode: 0o600, flag: 'wx' });
      const module = fileURLToPath(new URL('../../../../modules/docker-workspace/', import.meta.url));
      for (const file of ['main.tf', '.terraform.lock.hcl']) {
        const path = join(directory, file);
        copyFileSync(join(module, file), path);
        chmodSync(path, 0o600);
      }
      writeFileSync(join(directory, 'runtime.auto.tfvars.json'), JSON.stringify({ owner: options.owner }), { mode: 0o600, flag: 'wx' });
      await run('tofu', ['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color']); initialized = true;
      applied = true;
      await run('tofu', ['apply', '-auto-approve', '-input=false', '-no-color']);
      const output = JSON.parse(await run('tofu', ['output', '-json']));
      volume = output.volume_name?.value;
      if (volume !== `agent-runtime-disk-${options.owner}`) throw Error('Disk volume output mismatch');
      await inspectVolume(false);
      const result = JSON.parse(await helper('create', false));
      if (!/^\/dev\/loop[0-9]+$/.test(result.device) || result.sizeBytes !== options.diskGiB * 1073741824) throw Error('Disk workspace output mismatch');
      writeFileSync(join(directory, 'workspace.json'), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
      return result;
    },
    async close() {
      if (closed) return;
      if (!created) { closed = true; return; }
      owned();
      if (options.resume) {
        await attestRetainedResources({ directory, owner: options.owner, module: 'docker-workspace', run: args => run('docker', args, true) });
        await run('tofu', ['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color'], true);
      }
      if (applied) {
        // A lost apply reply can still have created the uniquely named volume.
        volume ??= `agent-runtime-disk-${options.owner}`;
        const volumes = (await run('docker', ['volume', 'ls', '--quiet', '--filter', `name=^${volume}$`], true)).trim();
        if (volumes) {
          if (volumes !== volume) throw Error('Disk volume identity unconfirmed');
          await inspectVolume(true);
          // Keep the stopped setup container referencing its backing volume:
          // Docker must not consider an active filesystem's storage unused.
          const creator = await inspectHelper('create');
          if (creator?.running) await run('docker', ['stop', '--time', '0', creator.id], true);
          await helper('remove', true);
          // The loop is absent before either reference is removed. A lost
          // helper reply leaves the containers available for bounded recovery.
          for (const operation of ['create', 'remove'] as const) {
            const container = await inspectHelper(operation);
            if (container?.running) throw Error('Disk helper cleanup unconfirmed');
            if (container) await run('docker', ['rm', container.id], true);
          }
        }
      }
      if (initialized) await run('tofu', ['destroy', '-auto-approve', '-input=false', '-no-color'], true);
      if ((await run('docker', ['volume', 'ls', '--quiet', '--filter', `label=agent-runtime.owner=${options.owner}`], true)).trim()) throw Error('Disk workspace cleanup unconfirmed');
      owned(); rmSync(directory, { recursive: true }); closed = true;
    },
  };
}
