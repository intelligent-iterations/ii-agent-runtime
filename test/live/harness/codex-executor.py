"""Offline upstream Codex executor probe; run as root in a disposable Linux container.

No real model, login or real credential is used. A synthetic private file tests
whether command and file operations stay in the selected unprivileged executor.
This exercises synthetic tool routing and named filesystem permissions, not live OAuth or container isolation.
"""
import base64
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
import importlib.util


def main():
    binary = str(Path(sys.argv[1]).resolve())
    expected = sys.argv[2]
    assert os.getuid() == 0, 'probe requires disposable Linux root'
    actual = subprocess.check_output([binary, '--version'], timeout=10, text=True).strip()
    assert actual == 'codex-cli ' + expected, 'Codex version mismatch'
    root = Path(tempfile.mkdtemp(prefix='executor-probe-', dir='/tmp'))
    owner = uuid.uuid4().hex
    (root / '.owner').write_text(owner)
    root.chmod(0o755)
    private = root / 'private'
    private.mkdir(mode=0o700)
    marker = private / 'credential-canary'
    marker.write_text('synthetic-private-value-' + owner)
    worker = root / 'worker'
    worker.mkdir(mode=0o700)
    os.chown(worker, 65534, 65534)
    home = root / 'controller'
    home.mkdir(mode=0o700)
    runuser = shutil.which('runuser')
    assert runuser, 'runuser is required'
    # Both the default and the available-environment list exclude local execution.
    configuration = '\n'.join([
        'default = "isolated"', 'include_local = false', '[[environments]]',
        'id = "isolated"', 'program = ' + json.dumps(runuser),
        'args = ' + json.dumps(['--user', 'nobody', '--', '/usr/bin/env', '-i',
                               'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=' + str(worker),
                               'CODEX_HOME=' + str(worker), binary, 'exec-server', '--listen', 'stdio']),
        'cwd = ' + json.dumps(str(worker)),
    ])
    (home / 'environments.toml').write_text(configuration)
    (home / 'config.toml').write_text('check_for_update_on_startup = false\nweb_search = "disabled"\n')
    process = subprocess.Popen([binary, 'app-server'], cwd=worker,
        env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(home), 'CODEX_HOME': str(home)},
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    pending = b''
    sequence = 0
    total = 0

    def rpc(method, params):
        nonlocal sequence, pending, total
        sequence += 1
        process.stdin.write((json.dumps({'id': sequence, 'method': method, 'params': params}) + '\n').encode())
        process.stdin.flush()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if b'\n' not in pending:
                if not selector.select(max(0, deadline - time.monotonic())):
                    break
                chunk = os.read(process.stdout.fileno(), 65536)
                assert chunk, 'app-server closed before responding'
                total += len(chunk)
                assert total <= 1048576, 'app-server output exceeded bound'
                pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                message = json.loads(line)
                if message.get('id') == sequence:
                    return message
        raise AssertionError('app-server request timed out: ' + method)

    try:
        initialized = rpc('initialize', {'clientInfo': {'name': 'executor_probe', 'version': '1.0.0'},
                                        'capabilities': {'experimentalApi': True}})
        assert 'result' in initialized, 'initialize failed'
        process.stdin.write(b'{"method":"initialized"}\n')
        process.stdin.flush()
        command = rpc('command/exec', {'command': ['/usr/bin/id', '-u'], 'cwd': str(worker), 'timeoutMs': 10000,
                                      'outputBytesCap': 4096, 'sandboxPolicy': {'type': 'dangerFullAccess'}})
        assert command.get('error', {}).get('message') == 'local environment is not configured', 'local execution did not fail closed'
        denied = rpc('fs/readFile', {'path': str(marker)})
        assert 'error' in denied, 'private controller file was readable'
        fixture_path = Path(__file__).with_name('codex-executor-fixture.py')
        spec = importlib.util.spec_from_file_location('executor_fixture', fixture_path)
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        result = fixture.prove_tool_routing(binary, home, worker, marker)
        evidence = {'codex': actual, 'toolRouting': result, 'localExecutionDisabled': True,
                    'realModelRequests': 0, 'realCredentials': False,
                    'limitations': ['UID separation only; not container isolation', 'no live OAuth']}
        print(json.dumps(evidence))
    finally:
        selector.close()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=10)
        assert (root / '.owner').read_text() == owner
        shutil.rmtree(root)


if __name__ == '__main__':
    main()
