"""Run the caller's command from the staged project, retaining a bounded log."""
import json,subprocess,sys
with open('/workspace/render.log','wb') as log:
 child=subprocess.Popen(sys.argv[1:],cwd='/workspace/repository',stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 remaining=1048576
 for chunk in iter(lambda:child.stdout.read(8192),b''):
  log.write(chunk[:remaining]);remaining=max(0,remaining-len(chunk))
 print(json.dumps({'exit_code':child.wait()}))
