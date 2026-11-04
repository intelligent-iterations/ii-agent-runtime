"""Run with an isolated venv containing moto[server]==5.1.16 and boto3.
Requires Docker Desktop for the pinned official AWS CLI v2 container.
Provider argument: aws or azure. Exit 2 means upstream coverage is unsupported.
"""
import io, json, pathlib, shutil, socket, subprocess, sys, time, urllib.request, uuid, zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
provider = sys.argv[1]
assert provider in ('aws', 'azure')
result = {'provider': provider, 'iamProof': False, 'status': 'failed'}
container = None
server = None
exit_code = 1
try:
    if provider == 'aws':
        import boto3
        import moto
        assert moto.__version__ == '5.1.16'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        endpoint = f'http://127.0.0.1:{port}'
        binary = pathlib.Path(sys.executable).parent
        server = subprocess.Popen([str(binary / 'moto_server'), '-H', '127.0.0.1', '-p', str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                # Fixed HTTP loopback URL; only the OS-assigned port varies.
                # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
                urllib.request.urlopen(endpoint, timeout=1).close()
                break
            except OSError:
                time.sleep(.1)
        options = dict(endpoint_url=endpoint, region_name='us-east-1', aws_access_key_id='testing', aws_secret_access_key='testing')
        iam = boto3.client('iam', **options)
        role = iam.create_role(RoleName='preflight', AssumeRolePolicyDocument=json.dumps({'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Service':'lambda.amazonaws.com'},'Action':'sts:AssumeRole'}]}))['Role']['Arn']
        iam.put_role_policy(RoleName='preflight',PolicyName='read-object',PolicyDocument=json.dumps({'Version':'2012-10-17','Statement':[{'Effect':'Allow','Action':'s3:GetObject','Resource':'arn:aws:s3:::preflight-bucket/object'}]}))
        code = io.BytesIO()
        with zipfile.ZipFile(code, 'w') as archive:
            archive.writestr('index.py', 'def handler(event, context): return {}')
        client = boto3.client('lambda', **options)
        resource = client.create_function(FunctionName='preflight', Runtime='python3.12', Role=role, Handler='index.handler', Code={'ZipFile':code.getvalue()})['FunctionArn']
        result.update(emulator='Moto', version=moto.__version__, cli='AWS CLI 2.31.30', cliImage='amazon/aws-cli@sha256:77c27e51823293d52691a13e87f6942a4b483e87de3f49d68c25dc271f3528b1')
        probe = subprocess.run(['node','--import','tsx','test/live/cloud-collector-emulator.ts',provider,endpoint,resource,role,shutil.which('docker')], cwd=ROOT, text=True, capture_output=True)
        client.delete_function(FunctionName='preflight')
        iam.delete_role_policy(RoleName='preflight',PolicyName='read-object')
        iam.delete_role(RoleName='preflight')
        assert not client.list_functions()['Functions']
        assert not iam.list_roles()['Roles']
        result['resourceCleanup'] = True
    else:
        image = 'floci/floci-az@sha256:530635d603223e120adbf9221a97560cffc6991d65fa0c72d0f79d1097974c89'
        container = subprocess.check_output(['docker','run','-d','--name','ii-preflight-'+uuid.uuid4().hex,'-p','127.0.0.1::4577',image],text=True).strip()
        endpoint = 'http://' + subprocess.check_output(['docker','port',container,'4577/tcp'],text=True).strip()
        def api(method, path, body=None):
            request = urllib.request.Request(endpoint+path, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type':'application/json'}, method=method)
            # HTTP endpoint comes from our loopback-bound container; callers supply constant API paths.
            # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            with urllib.request.urlopen(request,timeout=10) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        for _ in range(60):
            try:
                api('GET','/ready'); break
            except OSError:
                time.sleep(.5)
        group='/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/preflight'
        resource=group+'/providers/Microsoft.Compute/virtualMachines/worker'
        api('PUT',group+'?api-version=2024-11-01',{'location':'eastus'})
        api('PUT',resource+'?api-version=2024-11-01',{'location':'eastus','identity':{'type':'SystemAssigned'},'properties':{'hardwareProfile':{'vmSize':'Standard_B1s'},'storageProfile':{'imageReference':{'id':'synthetic-image'}},'osProfile':{'computerName':'worker','adminUsername':'test'}}})
        vm=api('GET',resource+'?api-version=2024-11-01')
        identity=vm.get('identity',{}).get('principalId','missing-upstream-identity')
        probe=subprocess.run(['node','--import','tsx','test/live/cloud-collector-emulator.ts',provider,endpoint,resource,identity],cwd=ROOT,text=True,capture_output=True)
        api('DELETE',resource+'?api-version=2024-11-01')
        assert not api('GET',group+'/providers/Microsoft.Compute/virtualMachines?api-version=2024-11-01').get('value',[])
        api('DELETE',group+'?api-version=2024-11-01')
        result.update(emulator='floci-az',version='0.15.0',image=image,resourceCleanup=True)
        if identity == 'missing-upstream-identity': result['limitation']='Upstream VM readback omits requested SystemAssigned identity'
    if probe.stdout: result['probe']=json.loads(probe.stdout)
    if probe.returncode not in (0,2): raise RuntimeError(probe.stderr)
    exit_code=probe.returncode
    result['status']='passed' if exit_code == 0 else 'unsupported'
finally:
    if server:
        server.terminate(); server.wait(timeout=10)
        with socket.socket() as sock: assert sock.connect_ex(('127.0.0.1',port)) != 0
        result['emulatorCleanup']=True
    if container:
        subprocess.run(['docker','rm','-f',container],check=True,stdout=subprocess.DEVNULL)
        result['emulatorCleanup']=True
    result['revision']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    print(json.dumps(result,indent=2))
sys.exit(exit_code)
