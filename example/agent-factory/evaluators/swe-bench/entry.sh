#!/bin/sh
# Run only through the protected entry point in a dedicated evaluator VM.
set -eu
mkdir -m 700 /opt/factory/benchmark-results
exec > /opt/factory/benchmark-results/execution.log 2>&1
retain_native() {
python3 - <<'PY'
from pathlib import Path
root=Path('/opt/factory/evaluation')
target=Path('/opt/factory/benchmark-results')
if (root/'receipt.json').is_file(): (target/'receipt.json').write_bytes((root/'receipt.json').read_bytes())
for name,out in [('test_output.txt','test-output.txt'),('run_instance.log','native-instance.log'),('report.json','native-report.json')]:
 files=list((root/'logs/evaluation').glob('*/*/*/'+name))
 if len(files)==1: (target/out).write_bytes(files[0].read_bytes())
PY
}
trap retain_native EXIT
test -x /opt/factory/swe-python/bin/python
test -x /usr/bin/docker
systemctl start docker
python3 - <<'PY'
import json,urllib.request,urllib.parse,hashlib
m=json.load(open('/opt/factory/workload/manifest.json'))
a=m['datasetArtifact']
url='https://huggingface.co/datasets/'+urllib.parse.quote(a['dataset'],safe='/')+'/resolve/'+a['revision']+'/'+urllib.parse.quote(a['file'],safe='/')
with urllib.request.urlopen(url,timeout=60) as response: data=response.read(128*1024*1024+1)
if len(data)>128*1024*1024 or hashlib.sha256(data).hexdigest()!=a['sha256']: raise ValueError('Dataset download differs')
with open('/opt/factory/dataset.parquet','xb') as output: output.write(data)
with open('/run/factory-evaluator','x') as marker: marker.write(m['evaluation']['runId'])
PY
/opt/factory/swe-python/bin/python -I /opt/factory/workload/evaluate.py /opt/factory/workload/manifest.json /opt/factory/dataset.parquet /opt/factory/swe-upstream /opt/factory/evaluation
