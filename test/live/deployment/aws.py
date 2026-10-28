"""Exercise generated EC2 IaC against Moto 5.1.16, never an AWS account.
Run with moto[server]==5.1.16 installed and moto_server on 127.0.0.1:14566.
This proves API provisioning/teardown, not a booted VM, IAM or network isolation.
"""
import json, os, pathlib, subprocess, tempfile, shutil
import boto3
root = pathlib.Path(__file__).resolve().parents[3]
endpoint = 'http://127.0.0.1:14566'
client = boto3.client('ec2', region_name='us-east-1', endpoint_url=endpoint,
                      aws_access_key_id='testing', aws_secret_access_key='testing')
parent = pathlib.Path(tempfile.mkdtemp(prefix='ii-aws-emulation-'))
work = parent / 'deployment'
region = 'us-east-1'
vpc = client.create_vpc(CidrBlock='10.42.0.0/16')['Vpc']['VpcId']
subnet = group = key = None
try:
    subnet = client.create_subnet(VpcId=vpc, CidrBlock='10.42.1.0/24')['Subnet']['SubnetId']
    group = client.create_security_group(GroupName='ii-emulator', Description='local proof', VpcId=vpc)['GroupId']
    key = 'ii-emulator'
    client.create_key_pair(KeyName=key)
    image = client.describe_images()['Images'][0]['ImageId']
    declaration = {'schemaVersion':1,'id':'emulated-app','provider':'aws',
        'infrastructure':{'ami':image,'instance_type':'t3.medium','subnet_id':subnet,'vpc_security_group_ids':[group],'key_name':key},
        'providerConfiguration':{'region':region}}
    source=parent/'declaration.json';source.write_text(json.dumps(declaration))
    subprocess.run(['node','--input-type=module','-e',
        "import {readFileSync} from 'node:fs';import {compileDeployment,writeDeployment} from './dist/deployment/index.js';writeDeployment(process.argv[2],compileDeployment(JSON.parse(readFileSync(process.argv[1],'utf8'))));",str(source),str(work)],cwd=root,check=True)
    # Only the API endpoint and credential discovery change for this emulator; generated EC2 resources are untouched.
    path=work/'main.tf.json';document=json.loads(path.read_text())
    document['provider']['aws'].update({'endpoints':[{'ec2':endpoint,'sts':endpoint}],
        'skip_credentials_validation':True,'skip_metadata_api_check':True,'skip_requesting_account_id':True})
    path.write_text(json.dumps(document,indent=2))
    cache=os.environ.get('II_PROVIDER_VALIDATION_CACHE')
    if cache:
        (work/'.terraform').symlink_to(pathlib.Path(cache)/'.terraform')
        shutil.copyfile(pathlib.Path(cache)/'.terraform.lock.hcl',work/'.terraform.lock.hcl')
    env={'PATH':os.environ['PATH'],'HOME':str(parent),'AWS_ACCESS_KEY_ID':'testing','AWS_SECRET_ACCESS_KEY':'testing','AWS_REGION':region,'AWS_EC2_METADATA_DISABLED':'true'}
    script="""import {planDeployment,applyDeployment} from './dist/deployment/index.js';
const options={directory:process.argv[1],environment:process.env};
const receipt=await planDeployment(options,process.argv[2]);
console.log(JSON.stringify(await applyDeployment(options,receipt.planDigest)));"""
    def operate(intent):
        return subprocess.run(['node','--input-type=module','-e',script,str(work),intent],cwd=root,env=env,check=True,capture_output=True,text=True).stdout
    print(operate('apply').strip())
    instances=[i for r in client.describe_instances()['Reservations'] for i in r['Instances'] if i['State']['Name']!='terminated']
    assert len(instances)==1,instances
    assert instances[0]['MetadataOptions']['HttpTokens']=='required'
    print(operate('destroy').strip())
    assert all(i['State']['Name']=='terminated' for r in client.describe_instances()['Reservations'] for i in r['Instances'])
    print('AWS Moto: generated EC2 apply, metadata policy readback, saved-plan destruction and state cleanup passed')
    print('Evidence:',work)
finally:
    # These are synthetic resources in this loopback emulator only.
    for reservation in client.describe_instances()['Reservations']:
        ids=[i['InstanceId'] for i in reservation['Instances'] if i['State']['Name']!='terminated']
        if ids: client.terminate_instances(InstanceIds=ids)
    if key:client.delete_key_pair(KeyName=key)
    if group:client.delete_security_group(GroupId=group)
    if subnet:client.delete_subnet(SubnetId=subnet)
    client.delete_vpc(VpcId=vpc)
