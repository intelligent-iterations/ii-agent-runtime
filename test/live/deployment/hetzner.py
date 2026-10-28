"""Generated Hetzner IaC against unmodified, revision-pinned upstream hcloud-mock.

Requires Python 3.12+ and OpenTofu. Owns its source checkout, venv, database,
listener and synthetic fixtures. No cloud credentials or account are used.
"""
import os
import pathlib
import socket
import subprocess
import sys
import time

from emulator_http import request
from iac_test import Deployment

REVISION = '89beaa1394bc360316f0272b0dcd55f3905cd669'
test = Deployment('hetzner', 'https://github.com/koval01/hcloud-mock@' + REVISION)
root = test.parent
process = None
port = None
key = firewall = None
baseline = {}
token = 't' * 64


def api(method, path, body=None):
    return request(endpoint, method, '/v1' + path, body, token)


try:
    with (root / 'install.log').open('w') as install:
        subprocess.run(['git', 'clone', '--quiet', 'https://github.com/koval01/hcloud-mock', str(root / 'upstream')], check=True, stdout=install, stderr=install)
        subprocess.run(['git', '-C', str(root / 'upstream'), 'checkout', '--quiet', REVISION], check=True, stdout=install, stderr=install)
        subprocess.run([sys.executable, '-m', 'venv', str(root / 'venv')], check=True, stdout=install, stderr=install)
        python = str(root / 'venv/bin/python')
        subprocess.run([python, '-m', 'pip', 'install', str(root / 'upstream')], check=True, stdout=install, stderr=install)
    test.result['emulatorDependencies'] = subprocess.check_output([python, '-m', 'pip', 'freeze'], text=True).splitlines()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    endpoint = f'http://127.0.0.1:{port}'
    log = (root / 'emulator.log').open('w')
    process = subprocess.Popen([python, '-m', 'uvicorn', 'hcloud_mock.main:app', '--host', '127.0.0.1', '--port', str(port)],
        env={'PATH': os.environ['PATH'], 'HCLOUD_MOCK_DB_PATH': str(root / 'hcloud.db'), 'HCLOUD_MOCK_TOKENS': token, 'HCLOUD_MOCK_ACTION_DELAY_MS': '100'},
        cwd=root, stdout=log, stderr=log)
    for attempt in range(100):
        try:
            api('GET', '/locations')
            break
        except (OSError, RuntimeError):
            if process.poll() is not None or attempt == 99:
                raise RuntimeError('Upstream emulator did not become ready; see emulator.log')
            time.sleep(.1)
    baseline = {collection: {item['id'] for item in api('GET', '/' + collection)[collection]} for collection in ['servers', 'firewalls', 'ssh_keys']}
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root / 'key')], check=True)
    key = api('POST', '/ssh_keys', {'name': 'test-key', 'public_key': (root / 'key.pub').read_text()})['ssh_key']['id']
    firewall = api('POST', '/firewalls', {'name': 'test-firewall', 'rules': []})['firewall']['id']
    test.prepare({'schemaVersion': 1, 'id': 'emulated-agent', 'provider': 'hetzner', 'providerConfiguration': {},
        'infrastructure': {'location': 'nbg1', 'server_type': 'cx22', 'image': 'ubuntu-24.04', 'ssh_keys': [key], 'firewall_ids': [firewall]}},
        'hcloud', {'endpoint': endpoint + '/v1', 'token': token})
    outputs = test.operate('apply')['outputs']
    servers = api('GET', '/servers')['servers']
    assert len(servers) == 1
    assert servers[0]['name'] == 'emulated-agent'
    assert str(servers[0]['id']) == str(outputs['instance_id']['value'])
    assert servers[0]['public_net']['ipv4']['ip'] == outputs['address']['value']
    test.result['createReadback'] = 'passed'
    test.operate('destroy')
    test.assert_empty_state()
    assert not api('GET', '/servers')['servers']
    test.result.update(status='passed', savedPlanDestroy='passed', resourceCleanup='passed')
    test.result['limitations'] = ['No guest boot or IAM proof', 'Bootstrap/user_data semantics not validated by upstream emulator']
except Exception as error:
    test.result.update(status='failed', error=str(error)[-7000:])
finally:
    if process is not None:
        try:
            for server in api('GET', '/servers')['servers']:
                api('DELETE', '/servers/' + str(server['id']))
            for collection, identifier in [('firewalls', firewall), ('ssh_keys', key)]:
                if identifier is not None:
                    api('DELETE', '/' + collection + '/' + str(identifier))
                for attempt in range(100):
                    if {item['id'] for item in api('GET', '/' + collection)[collection]} == baseline[collection]:
                        break
                    if attempt == 99:
                        raise AssertionError(collection + ' fixture cleanup mismatch')
                    time.sleep(.1)
            assert not api('GET', '/servers')['servers']
            test.result['fixtureCleanup'] = 'passed'
        except Exception as error:
            test.result.update(status='failed', cleanupError=str(error))
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        log.close()
        with socket.socket() as listener:
            closed = listener.connect_ex(('127.0.0.1', port)) != 0
        test.result['emulatorCleanup'] = 'passed' if closed else 'failed'
        if not closed:
            test.result['status'] = 'failed'
    test.record()
sys.exit(0 if test.result['status'] == 'passed' else 1)
