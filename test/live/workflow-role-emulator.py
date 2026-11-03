"""Run with an isolated venv containing moto[server]==5.1.16 and boto3, plus the official AWS CLI v2.

python -I test/live/workflow-role-emulator.py /absolute/path/to/aws-cli-v2/aws

Seeds a GitHub OIDC provider, a deploy role, an inline policy and an attached managed
policy through the emulator's IAM API, runs the production workflow role assessor
through the given CLI, then deletes everything. Docker is not required.
"""
import datetime, hashlib, json, pathlib, socket, subprocess, sys, time, urllib.request

import boto3
import moto

ROOT = pathlib.Path(__file__).resolve().parents[2]
cli = sys.argv[1]
assert pathlib.Path(cli).is_absolute()
assert moto.__version__ == '5.1.16'
result = {'provider': 'aws', 'check': 'github.workflow-execution identity join', 'iamProof': False, 'status': 'failed'}
server = None
exit_code = 1
try:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    endpoint = f'http://127.0.0.1:{port}'
    server = subprocess.Popen([str(pathlib.Path(sys.executable).parent / 'moto_server'), '-H', '127.0.0.1', '-p', str(port)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            # Fixed HTTP loopback URL; only the OS-assigned port varies.
            # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            urllib.request.urlopen(endpoint, timeout=1).close()
            break
        except OSError:
            time.sleep(.1)
    iam = boto3.client('iam', endpoint_url=endpoint, region_name='us-east-1', aws_access_key_id='testing', aws_secret_access_key='testing')
    provider = iam.create_open_id_connect_provider(Url='https://token.actions.githubusercontent.com', ClientIDList=['sts.amazonaws.com'],
                                                   ThumbprintList=['6938fd4d98bab03faadb97b34396831e3780aea1'])['OpenIDConnectProviderArn']
    trust = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Federated': provider},
             'Action': 'sts:AssumeRoleWithWebIdentity', 'Condition': {'StringEquals': {
                 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                 'token.actions.githubusercontent.com:sub': 'repo:org/app:ref:refs/heads/main'}}}]}
    role = iam.create_role(RoleName='app-deploy', AssumeRolePolicyDocument=json.dumps(trust))['Role']['Arn']
    account = role.split(':')[4]
    iam.put_role_policy(RoleName='app-deploy', PolicyName='deploy', PolicyDocument=json.dumps({'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': ['lambda:UpdateFunctionCode', 'lambda:PublishVersion'], 'Resource': f'arn:aws:lambda:us-east-1:{account}:function:api'},
        {'Effect': 'Allow', 'Action': 's3:PutObject', 'Resource': 'arn:aws:s3:::app-assets/site/index.html'}]}))
    managed = iam.create_policy(PolicyName='cdn-invalidate', PolicyDocument=json.dumps({'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': 'cloudfront:CreateInvalidation', 'Resource': f'arn:aws:cloudfront::{account}:distribution/E2EXAMPLE'}]}))['Policy']['Arn']
    iam.attach_role_policy(RoleName='app-deploy', PolicyArn=managed)
    assert iam.get_role(RoleName='app-deploy')['Role']['Arn'] == role
    cli_version = subprocess.run([cli, '--version'], capture_output=True, text=True, check=True)
    result.update(emulator='Moto', version=moto.__version__, cli=(cli_version.stdout or cli_version.stderr).strip(), seeded={
        'oidcProvider': provider, 'role': role, 'inlinePolicyStatements': 2, 'attachedPolicy': managed})
    missing = f'arn:aws:iam::{account}:role/absent-deploy'
    probe = subprocess.run(['node', '--import', 'tsx', 'test/live/workflow-role-emulator.ts', endpoint, role, missing, cli],
                           cwd=ROOT, text=True, capture_output=True)
    iam.detach_role_policy(RoleName='app-deploy', PolicyArn=managed)
    iam.delete_policy(PolicyArn=managed)
    iam.delete_role_policy(RoleName='app-deploy', PolicyName='deploy')
    iam.delete_role(RoleName='app-deploy')
    iam.delete_open_id_connect_provider(OpenIDConnectProviderArn=provider)
    assert not iam.list_roles()['Roles']
    assert not iam.list_policies(Scope='Local')['Policies']
    assert not iam.list_open_id_connect_providers()['OpenIDConnectProviderList']
    result['resourceCleanup'] = True
    if probe.stdout:
        result['probe'] = json.loads(probe.stdout)
    if probe.returncode != 0:
        raise RuntimeError(probe.stderr[-4000:])
    exit_code = 0
    result['status'] = 'passed'
finally:
    if server:
        server.terminate()
        server.wait(timeout=10)
        with socket.socket() as sock:
            assert sock.connect_ex(('127.0.0.1', port)) != 0
        result['emulatorCleanup'] = True
    result['revision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    result['runner_sha256'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                               for name in ('test/live/workflow-role-emulator.ts', 'test/live/workflow-role-emulator.py')}
    result['recorded_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    result['command'] = 'python -I test/live/workflow-role-emulator.py <aws-cli-v2>/aws'
    print(json.dumps(result, indent=2))
sys.exit(exit_code)
