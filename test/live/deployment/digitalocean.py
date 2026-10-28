"""Run through digitalocean-emulator's Go test, which owns the upstream emulator."""
import json, os, pathlib, subprocess, tempfile, shutil
from emulator_http import request

ROOT = pathlib.Path(__file__).resolve().parents[3]
endpoint = os.environ['II_DO_EMULATOR_ENDPOINT']
parent = pathlib.Path(tempfile.mkdtemp(prefix='ii-do-emulation-'))
work = parent / 'deployment'
result = {'provider': 'digitalocean', 'emulator': 'gravel/dotest', 'version': 'v0.10.3',
          'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
          'status': 'failed', 'scope': 'compute-api', 'guestExecution': 'not-tested', 'iam': 'not-tested'}
def api(method, path, body=None):
    return request(endpoint, method, '/v2' + path, body, token='test')

try:
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(parent / 'synthetic-key')], check=True)
    key = api('POST', '/account/keys', {'name': 'ii-emulator', 'public_key': (parent / 'synthetic-key.pub').read_text().strip()})['ssh_key']['id']
    declaration = {'schemaVersion': 1, 'id': 'emulated-agent', 'provider': 'digitalocean',
                   'infrastructure': {'region': 'nyc3', 'size': 's-2vcpu-4gb', 'image': 'ubuntu-24-04-x64',
                                      'ssh_keys': [str(key)], 'vpc_uuid': '00000000-0000-4000-8000-000000000001'},
                   'providerConfiguration': {}}
    source = parent / 'declaration.json'; source.write_text(json.dumps(declaration))
    subprocess.run(['node', '--input-type=module', '-e',
                    "import {readFileSync} from 'node:fs';import {compileDeployment,writeDeployment} from './dist/deployment/index.js';writeDeployment(process.argv[2],compileDeployment(JSON.parse(readFileSync(process.argv[1],'utf8'))));",
                    str(source), str(work)], cwd=ROOT, check=True)
    path = work / 'main.tf.json'; document = json.loads(path.read_text())
    result['plugin'] = document['terraform']['required_providers']['digitalocean']
    document['provider']['digitalocean'].update({'api_endpoint': endpoint, 'token': 'test'})
    path.write_text(json.dumps(document, indent=2))
    cache = os.environ.get('II_PROVIDER_VALIDATION_CACHE')
    if cache:
        (work / '.terraform').symlink_to(pathlib.Path(cache) / '.terraform')
        shutil.copyfile(pathlib.Path(cache) / '.terraform.lock.hcl', work / '.terraform.lock.hcl')
    env = {'PATH': os.environ['PATH'], 'HOME': str(parent), 'CHECKPOINT_DISABLE': '1'}
    script = """import {planDeployment,applyDeployment} from './dist/deployment/index.js';
import {execFileSync} from 'node:child_process';
const options={directory:process.argv[1],environment:process.env,process:async request => {
try { return execFileSync(request.command,request.args,{cwd:request.cwd,env:request.env,encoding:'utf8',timeout:request.timeoutMs,maxBuffer:request.maxOutputBytes}); }
catch(error) { console.error(String(error.stdout),String(error.stderr)); throw error; }
}};
const receipt=await planDeployment(options,process.argv[2]);
console.log(JSON.stringify(await applyDeployment(options,receipt.planDigest)));"""
    def operate(intent, denied=False):
        run = subprocess.run(['node', '--input-type=module', '-e', script, str(work), intent], cwd=ROOT, env=env,
                             capture_output=True, text=True, timeout=240)
        (parent / (('denied-' if denied else '') + intent + '.log')).write_text(run.stdout + run.stderr)
        if denied:
            assert run.returncode != 0 and '401' in run.stderr, run.stdout + run.stderr
        elif run.returncode: raise RuntimeError(run.stdout + run.stderr)
        else: print(run.stdout.strip())
    operate('apply')
    droplets = api('GET', '/droplets')['droplets']
    assert len(droplets) == 1, droplets
    assert droplets[0]['name'] == 'emulated-agent'
    assert droplets[0]['status'] == 'active'
    assert any(network['type'] == 'private' for network in droplets[0]['networks']['v4'])
    result['createReadback'] = 'passed'
    operate('destroy')
    assert not api('GET', '/droplets')['droplets']
    assert not json.loads((work / 'terraform.tfstate').read_text()).get('resources', [])
    # Upstream has no key-delete or VPC API; the owned server disposes seeded key state.
    result['fixtureLimitations'] = ['VPC reference not validated', 'seeded SSH key removed with emulator, not API']
    document['provider']['digitalocean']['token'] = 'wrong-synthetic-token'
    path.write_text(json.dumps(document, indent=2))
    operate('apply', denied=True)
    assert not api('GET', '/droplets')['droplets']
    result['credentialDenial'] = 'passed'
    result.update(status='passed', savedPlanDestroy='passed', resourceCleanup='passed')
finally:
    (parent / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    print('Evidence:', parent)
