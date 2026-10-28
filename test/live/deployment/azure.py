"""Generated Azure VM IaC against Floci Azure 0.15.0; no guest or IAM proof.
Requires Docker and a built modules/remote-host image (II_EMULATOR_RUNNER_IMAGE).
Uses a Linux runner so its private CA trust does not modify the host trust store.
"""
import base64, json, os, pathlib, subprocess, tempfile, time, uuid

from emulator_http import request, read

ROOT = pathlib.Path(__file__).resolve().parents[3]
IMAGE = 'floci/floci-az@sha256:530635d603223e120adbf9221a97560cffc6991d65fa0c72d0f79d1097974c89'
runner = os.environ.get('II_EMULATOR_RUNNER_IMAGE', 'ii-runtime-executor:20261026')
parent_root = pathlib.Path.home() / '.cache' / 'ii-runtime-emulators'
parent_root.mkdir(parents=True, exist_ok=True)
parent = pathlib.Path(tempfile.mkdtemp(prefix='azure-', dir=parent_root))
work = parent / 'deployment'
name = 'ii-azure-emulator-' + uuid.uuid4().hex[:12]
container = None
result = {'provider': 'azure', 'emulator': 'floci-az', 'version': '0.15.0', 'image': IMAGE,
          'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
          'status': 'failed', 'scope': 'compute-api', 'guestExecution': 'not-tested', 'iam': 'not-tested'}
try:
    container = subprocess.check_output(['docker', 'run', '-d', '--name', name, '-e', 'FLOCI_AZ_TLS_ENABLED=true',
                                         '-p', '127.0.0.1::4577', IMAGE], text=True).strip()
    endpoint = 'http://' + subprocess.check_output(['docker', 'port', container, '4577/tcp'], text=True).strip()
    def api(method, path, body=None):
        return request(endpoint, method, path, body)
    for attempt in range(60):
        try:
            api('GET', '/ready'); break
        except (OSError, RuntimeError):
            if attempt == 59: raise
            time.sleep(1)
    (parent / 'ca.pem').write_bytes(read(endpoint, 'GET', '/_floci/tls-cert'))
    subscription = '00000000-0000-0000-0000-000000000001'
    tenant = '00000000-0000-0000-0000-000000000002'
    rg = '/subscriptions/' + subscription + '/resourceGroups/ii-emulator'
    network = rg + '/providers/Microsoft.Network/virtualNetworks/ii-network'
    subnet = network + '/subnets/ii-subnet'
    nic = rg + '/providers/Microsoft.Network/networkInterfaces/ii-nic'
    image = rg + '/providers/Microsoft.Compute/images/ii-image'
    api('PUT', rg + '?api-version=2024-03-01', {'location': 'eastus'})
    api('PUT', network + '?api-version=2024-05-01', {'location': 'eastus', 'properties': {'addressSpace': {'addressPrefixes': ['10.42.0.0/16']}}})
    api('PUT', subnet + '?api-version=2024-05-01', {'properties': {'addressPrefix': '10.42.0.0/24'}})
    api('PUT', nic + '?api-version=2024-05-01', {'location': 'eastus', 'properties': {'ipConfigurations': [{'name': 'internal', 'properties': {'subnet': {'id': subnet}, 'privateIPAllocationMethod': 'Dynamic'}}]}})
    # Floci 0.15.0 has no images API: this is an opaque reference, not image validation.
    result['customImageValidation'] = 'not-supported-by-emulator'
    # Synthetic key, generated for this emulator only; only its public half is compiled.
    subprocess.run(['ssh-keygen', '-q', '-t', 'rsa', '-b', '2048', '-N', '', '-f', str(parent / 'synthetic-key')], check=True)
    key = (parent / 'synthetic-key.pub').read_text().strip()
    declaration = {'schemaVersion': 1, 'id': 'emulated-agent', 'provider': 'azure',
                   'infrastructure': {'location': 'eastus', 'resource_group_name': 'ii-emulator', 'size': 'Standard_B1s',
                                      'network_interface_ids': [nic], 'admin_username': 'operator',
                                      'admin_ssh_key': [{'username': 'operator', 'public_key': key}], 'source_image_id': image},
                   'providerConfiguration': {'subscription_id': subscription, 'tenant_id': tenant}}
    source = parent / 'declaration.json'; source.write_text(json.dumps(declaration))
    subprocess.run(['node', '--input-type=module', '-e',
                    "import {readFileSync} from 'node:fs';import {compileDeployment,writeDeployment} from './dist/deployment/index.js';writeDeployment(process.argv[2],compileDeployment(JSON.parse(readFileSync(process.argv[1],'utf8'))));",
                    str(source), str(work)], cwd=ROOT, check=True)
    path = work / 'main.tf.json'; document = json.loads(path.read_text())
    result['plugin'] = document['terraform']['required_providers']['azurerm']
    document['provider']['azurerm'].update({'environment': 'stack', 'metadata_host': 'localhost:4577', 'use_cli': False,
                                           'client_id': '00000000-0000-0000-0000-000000000003', 'client_secret': 'synthetic-secret'})
    path.write_text(json.dumps(document, indent=2))
    script = """import {planDeployment,applyDeployment} from './dist/deployment/index.js';
import {execFileSync} from 'node:child_process';
const options={directory:'/work/deployment',environment:process.env,process:async request => {
try { return execFileSync(request.command,request.args,{cwd:request.cwd,env:request.env,encoding:'utf8',timeout:request.timeoutMs,maxBuffer:request.maxOutputBytes}); }
catch(error) { console.error(String(error.stdout),String(error.stderr)); throw error; }
}};
const receipt=await planDeployment(options,process.argv[1]);
console.log(JSON.stringify(await applyDeployment(options,receipt.planDigest)));"""
    def operate(intent):
        runner_name = name + '-' + intent
        try:
            run = subprocess.run(['docker', 'run', '--rm', '--name', runner_name, '--network', 'container:' + container,
                              '-v', str(ROOT) + ':/runtime:ro', '-v', str(parent) + ':/work', '-w', '/runtime',
                              '-e', 'HOME=/work', '-e', 'SSL_CERT_FILE=/work/ca.pem', '-e', 'CHECKPOINT_DISABLE=1',
                              '--entrypoint', 'node', runner, '--input-type=module', '-e', script, intent],
                             capture_output=True, text=True, timeout=360)
        finally:
            subprocess.run(['docker', 'rm', '-f', runner_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (parent / (intent + '.log')).write_text(run.stdout + run.stderr)
        if run.returncode: raise RuntimeError(run.stdout + run.stderr)
        print(run.stdout.strip())
    operate('apply')
    vm = api('GET', rg + '/providers/Microsoft.Compute/virtualMachines/emulated-agent?api-version=2024-03-01')
    profile = vm['properties']['osProfile']
    assert profile['linuxConfiguration']['disablePasswordAuthentication'] is True
    assert 'docker.io' in base64.b64decode(profile['customData']).decode()
    result['createReadback'] = 'passed'
    operate('destroy')
    assert not api('GET', rg + '/providers/Microsoft.Compute/virtualMachines?api-version=2024-03-01').get('value', [])
    assert not json.loads((work / 'terraform.tfstate').read_text()).get('resources', [])
    result.update(status='passed', savedPlanDestroy='passed', resourceCleanup='passed')
finally:
    if container:
        (parent / 'emulator.log').write_text(subprocess.check_output(['docker', 'logs', container], stderr=subprocess.STDOUT, text=True))
        subprocess.run(['docker', 'rm', '-f', container], check=True, stdout=subprocess.DEVNULL)
        result['emulatorCleanup'] = 'passed'
    (parent / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    print('Evidence:', parent)
