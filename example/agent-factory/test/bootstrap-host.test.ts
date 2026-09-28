import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'factory-bootstrap-')); const bin = join(root, 'bin'); mkdirSync(bin);
  const trace = join(root, 'trace');
  const executable = (name: string, text: string) => { const file = join(bin, name); writeFileSync(file, '#!/bin/bash\nset -eu\n' + text); chmodSync(file, 0o700); };
  const program = join(root, 'program');
  writeFileSync(program, `#!/bin/bash
set -eu
name="$(basename "$0")"
printf '%s\\n' "$name $*" >> "$FACTORY_TEST_TRACE"
if [ "$name" = node ] && [ "$1" = -p ]; then printf '%s\\n' "$FACTORY_TEST_BIN/softnet"; fi
if [ "$name" = gh ] && [ "$1 $2" = 'auth status' ]; then test -f "$FACTORY_TEST_AUTH"; fi
if [ "$name" = gh ] && [ "$1 $2" = 'auth login' ]; then touch "$FACTORY_TEST_AUTH"; fi
`); chmodSync(program, 0o700);
  executable('brew', `printf '%s\\n' "brew $*" >> "$FACTORY_TEST_TRACE"
test "$FACTORY_TEST_FAIL" != "$2"
case "$2" in node@22) name=node;; gh) name=gh;; opentofu) name=tofu;; */tart) name=tart;; */softnet) name=softnet;; *) exit 2;; esac
cp "$FACTORY_TEST_PROGRAM" "$FACTORY_TEST_BIN/$name"
`);
  executable('sudo', 'printf \'%s\\n\' "sudo $*" >> "$FACTORY_TEST_TRACE"\n');
  const script = fileURLToPath(new URL('../scripts/bootstrap-host.sh', import.meta.url));
  const run = (failure = '') => execFileSync('/bin/bash', ['-eu', '-c', '. "$1"; factory_prepare_host', 'bootstrap-test', script], {
    env: { PATH: `${bin}:/usr/bin:/bin`, FACTORY_TEST_BIN: bin, FACTORY_TEST_TRACE: trace, FACTORY_TEST_AUTH: join(root, 'authenticated'),
      FACTORY_TEST_PROGRAM: program, FACTORY_TEST_FAIL: failure }, stdio: 'pipe', encoding: 'utf8',
  });
  return { run, trace: () => readFileSync(trace, 'utf8'), close() { rmSync(root, { recursive: true, force: true }); } };
}

test('host bootstrap installs missing tools and reuses installed prerequisites', () => {
  const f = fixture();
  try {
    f.run(); const first = f.trace();
    for (const formula of ['node@22', 'opentofu', 'cirruslabs/cli/tart', 'cirruslabs/cli/softnet']) assert.ok(first.includes(`brew install ${formula}\n`));
    assert.doesNotMatch(first, /gh auth/);
    assert.match(first, /sudo chmod u\+s/);
    f.run(); const second = f.trace();
    assert.equal(second.match(/brew install /g)?.length, 4);
  } finally { f.close(); }
});

test('failed prerequisite installation stops before privileged setup', () => {
  const f = fixture();
  try {
    assert.throws(() => f.run('opentofu'));
    assert.doesNotMatch(f.trace(), /gh auth|sudo /);
    f.run(); assert.doesNotMatch(f.trace(), /gh auth/);
  } finally { f.close(); }
});
