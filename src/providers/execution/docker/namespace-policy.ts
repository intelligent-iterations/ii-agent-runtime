import type { ProcessRequest } from '../../shared/process.js';

const imagePattern = /^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const program = `set -eu
profile="$1"
operation="$2"
file=$(mktemp)
trap 'rm -f -- "$file"' EXIT
cat > "$file"
present() { grep -Eq "^$profile \\(" /sys/kernel/security/apparmor/profiles; }
case "$operation" in
  add) if present; then exit 1; fi; apparmor_parser --skip-cache --add "$file"; present ;;
  remove) if present; then apparmor_parser --skip-cache --remove "$file"; fi; ! present ;;
  *) exit 2 ;;
esac
`;

/** A run-owned host policy enabling the harness's nested namespace sandbox. */
export function dockerNamespacePolicy(options: {
  owner: string; image: string; resume?: boolean; directory: string; environment: Record<string, string>;
  execute(request: ProcessRequest, cleanup: boolean): Promise<string>;
}) {
  if (!/^[a-f0-9]{32}$/.test(options.owner) || !imagePattern.test(options.image)) throw Error('Invalid namespace policy binding');
  const profile = `ii-runtime-userns-${options.owner}`;
  const container = `ii-policy-${options.owner}`;
  const input = `abi <abi/4.0>,\nprofile ${profile} flags=(unconfined) { userns, }\n`;
  let attempted = options.resume ?? false, closed = false;
  const execute = (args: string[], cleanup: boolean, stdin?: string) => options.execute({
    command: 'docker', args, cwd: options.directory, env: options.environment,
    timeoutMs: 30000, maxOutputBytes: 65536, ...(stdin === undefined ? {} : { input: stdin }),
  }, cleanup);
  const apply = (operation: 'add' | 'remove', cleanup: boolean) => execute([
    'run', '--rm', '--interactive', '--name', container, '--label', `agent-runtime.owner=${options.owner}`,
    '--cpus', '0.25', '--memory', '128m', '--memory-swap', '128m', '--pids-limit', '32',
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'MAC_ADMIN',
    '--security-opt', 'apparmor=unconfined', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--mount', 'type=bind,source=/sys/kernel/security,target=/sys/kernel/security',
    '--entrypoint', '/bin/sh', options.image, '-c', program, 'policy', profile, operation,
  ], cleanup, input);
  return {
    profile,
    async create() {
      if (attempted || closed) throw Error('Namespace policy already used');
      attempted = true;
      await apply('add', false);
    },
    async close() {
      if (closed) return;
      if (attempted) {
        // Losing the Docker CLI can leave its helper alive. Inspect ownership
        // before removing it, then reconcile the uniquely named kernel policy.
        const ids = (await execute(['ps', '--all', '--quiet', '--filter', `name=^/${container}$`], true)).trim();
        if (ids) {
          if (!/^[a-f0-9]{12,64}$/.test(ids)) throw Error('Namespace helper identity unconfirmed');
          const inspected = JSON.parse(await execute(['inspect', ids], true)) as Array<{ Config?: { Labels?: Record<string, string> } }>;
          if (inspected.length !== 1 || inspected[0]?.Config?.Labels?.['agent-runtime.owner'] !== options.owner) throw Error('Namespace helper ownership changed');
          await execute(['rm', '--force', ids], true);
        }
        await apply('remove', true);
        if ((await execute(['ps', '--all', '--quiet', '--filter', `name=^/${container}$`], true)).trim()) throw Error('Namespace helper cleanup unconfirmed');
      }
      closed = true;
    },
  };
}
