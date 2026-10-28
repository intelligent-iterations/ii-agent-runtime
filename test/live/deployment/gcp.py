"""Generated GCE IaC against Floci GCP 0.11.0 (compute API only, no guest/IAM proof).
Run after npm run build; requires Docker, OpenTofu and Python 3.
Optional II_PROVIDER_VALIDATION_CACHE reuses the pinned provider installation.
"""
import json, os, pathlib, subprocess, tempfile, shutil, time, uuid

from emulator_http import request

ROOT = pathlib.Path(__file__).resolve().parents[3]
IMAGE = 'floci/floci-gcp@sha256:eae9683d806ceb643bcb36aee97cdb8cad13c3e2959cd053bf40e481994fde12'
name = 'ii-gcp-emulator-' + uuid.uuid4().hex[:12]
parent = pathlib.Path(tempfile.mkdtemp(prefix='ii-gcp-emulation-'))
work = parent / 'deployment'
container = None
result = {'provider': 'gcp', 'emulator': 'floci-gcp', 'version': '0.11.0', 'image': IMAGE,
          'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
          'status': 'failed', 'scope': 'compute-api', 'guestExecution': 'not-tested', 'iam': 'not-tested'}
try:
    container = subprocess.check_output(['docker', 'run', '-d', '--name', name, '-p', '127.0.0.1::4588', IMAGE], text=True).strip()
    address = subprocess.check_output(['docker', 'port', container, '4588/tcp'], text=True).strip()
    endpoint = 'http://' + address
    base = '/compute/v1/projects/ii-emulator'
    def api(method, path, body=None):
        response = request(endpoint, method, path, body)
        if method in ('POST', 'DELETE') and response.get('kind') == 'compute#operation':
            operation = response['selfLink'].split('/compute/v1/', 1)[1]
            for _ in range(60):
                response = api('GET', '/compute/v1/' + operation)
                if response.get('status') == 'DONE':
                    if response.get('error'): raise RuntimeError(str(response['error']))
                    break
                time.sleep(0.1)
            else: raise RuntimeError('Operation did not complete')
        return response
    for attempt in range(60):
        try:
            api('GET', base + '/zones/us-central1-a/machineTypes/e2-standard-2')
            break
        except (OSError, RuntimeError):
            if attempt == 59: raise
            time.sleep(1)
    api('POST', base + '/global/networks', {'name': 'ii-network', 'autoCreateSubnetworks': False})
    api('POST', base + '/regions/us-central1/subnetworks', {'name': 'ii-subnet', 'network': 'projects/ii-emulator/global/networks/ii-network', 'ipCidrRange': '10.42.0.0/24'})
    api('POST', base + '/zones/us-central1-a/disks', {'name': 'ii-seed', 'sizeGb': '10'})
    api('POST', base + '/global/images', {'name': 'ii-image', 'sourceDisk': 'projects/ii-emulator/zones/us-central1-a/disks/ii-seed'})
    declaration = {'schemaVersion': 1, 'id': 'emulated-agent', 'provider': 'gcp',
                   'infrastructure': {'zone': 'us-central1-a', 'machine_type': 'e2-standard-2',
                                      'boot_disk': [{'initialize_params': [{'image': 'projects/ii-emulator/global/images/ii-image'}]}],
                                      'network_interface': [{'subnetwork': 'projects/ii-emulator/regions/us-central1/subnetworks/ii-subnet'}]},
                   'providerConfiguration': {'project': 'ii-emulator', 'region': 'us-central1'}}
    source = parent / 'declaration.json'; source.write_text(json.dumps(declaration))
    subprocess.run(['node', '--input-type=module', '-e',
                    "import {readFileSync} from 'node:fs';import {compileDeployment,writeDeployment} from './dist/deployment/index.js';writeDeployment(process.argv[2],compileDeployment(JSON.parse(readFileSync(process.argv[1],'utf8'))));",
                    str(source), str(work)], cwd=ROOT, check=True)
    path = work / 'main.tf.json'; document = json.loads(path.read_text())
    result['plugin'] = document['terraform']['required_providers']['google']
    # Resources are unchanged: only endpoint and synthetic authentication differ.
    document['provider']['google'].update({'compute_custom_endpoint': endpoint + '/compute/v1/', 'access_token': 'synthetic-emulator-token'})
    path.write_text(json.dumps(document, indent=2))
    cache = os.environ.get('II_PROVIDER_VALIDATION_CACHE')
    if cache:
        (work / '.terraform').symlink_to(pathlib.Path(cache) / '.terraform')
        shutil.copyfile(pathlib.Path(cache) / '.terraform.lock.hcl', work / '.terraform.lock.hcl')
    env = {'PATH': os.environ['PATH'], 'HOME': str(parent), 'GCE_METADATA_HOST': '127.0.0.1:1', 'CHECKPOINT_DISABLE': '1'}
    script = """import {planDeployment,applyDeployment} from './dist/deployment/index.js';
import {execFileSync} from 'node:child_process';
const options={directory:process.argv[1],environment:process.env,process:async request => {
try { return execFileSync(request.command,request.args,{cwd:request.cwd,env:request.env,encoding:'utf8',timeout:request.timeoutMs,maxBuffer:request.maxOutputBytes}); }
catch(error) { console.error(String(error.stdout),String(error.stderr)); throw error; }
}};
const receipt=await planDeployment(options,process.argv[2]);
console.log(JSON.stringify(await applyDeployment(options,receipt.planDigest)));"""
    def operate(intent):
        run = subprocess.run(['node', '--input-type=module', '-e', script, str(work), intent], cwd=ROOT, env=env,
                             capture_output=True, text=True, timeout=240)
        (parent / (intent + '.log')).write_text(run.stdout + run.stderr)
        if run.returncode: raise RuntimeError(run.stdout + run.stderr)
        print(run.stdout.strip())
    operate('apply')
    instances = api('GET', base + '/zones/us-central1-a/instances').get('items', [])
    assert len(instances) == 1, instances
    instance = instances[0]
    metadata = {item['key']: item['value'] for item in instance['metadata']['items']}
    assert metadata['enable-oslogin'] == 'TRUE'
    assert metadata['block-project-ssh-keys'] == 'TRUE'
    assert 'docker.io' in metadata['user-data']
    assert instance['shieldedInstanceConfig']['enableSecureBoot'] is True
    assert instance['networkInterfaces'][0]['networkIP']
    result['createReadback'] = 'passed'
    operate('destroy')
    assert not api('GET', base + '/zones/us-central1-a/instances').get('items', [])
    assert [disk['name'] for disk in api('GET', base + '/zones/us-central1-a/disks').get('items', [])] == ['ii-seed']
    api('DELETE', base + '/global/images/ii-image')
    api('DELETE', base + '/zones/us-central1-a/disks/ii-seed')
    api('DELETE', base + '/regions/us-central1/subnetworks/ii-subnet')
    api('DELETE', base + '/global/networks/ii-network')
    state = json.loads((work / 'terraform.tfstate').read_text())
    assert not state.get('resources', [])
    result.update(status='passed', savedPlanDestroy='passed', resourceCleanup='passed')
finally:
    if container:
        (parent / 'emulator.log').write_text(subprocess.check_output(['docker', 'logs', container], stderr=subprocess.STDOUT, text=True))
        subprocess.run(['docker', 'rm', '-f', container], check=True, stdout=subprocess.DEVNULL)
        result['emulatorCleanup'] = 'passed'
    (parent / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    print('Evidence:', parent)
