"""Validate MP4-only inputs in a fresh worker that never executes project code.

A video that fails a check prints {"error": code, "file": name, ...} and exits 0, so
the coordinator can say which check failed and how to fix it."""
import hashlib,json,os,stat,subprocess,sys
from pathlib import Path
limit=int(sys.argv[1]);count=int(sys.argv[2]);root=Path('/workspace/repository/out')
def fail(code,**extra):
 print(json.dumps({'error':code,**extra}));sys.exit(0)
if root.is_symlink() or not root.is_dir():fail('no-out')
files=sorted(root.glob('*.mp4'))
if len(files)!=count:fail('count')
records=[];opened=[];total=0
try:
 for p in files:
  fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW);f=os.fdopen(fd,'rb');opened.append(f);info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:fail('not-regular',file=p.name)
  total+=info.st_size
  if total>limit:fail('too-large')
  try:
   result=subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(p)],capture_output=True,text=True,timeout=30,check=True)
   probe=json.loads(result.stdout);duration=float(probe['format']['duration'])
  except Exception:fail('unreadable',file=p.name)
  video=next((s for s in probe['streams'] if s.get('codec_type')=='video'),None)
  if video is None:fail('no-video',file=p.name)
  if not video['height']>video['width']:fail('landscape',file=p.name,width=video['width'],height=video['height'])
  if not any(s.get('codec_type')=='audio' for s in probe['streams']):fail('no-audio',file=p.name)
  if not 0<duration<=180:fail('duration',file=p.name,seconds=round(duration,2))
  if subprocess.run(['ffmpeg','-v','error','-threads','1','-i',str(p),'-f','null','-'],capture_output=True,timeout=120).returncode!=0:fail('decode',file=p.name)
  h=hashlib.file_digest(f,'sha256').hexdigest();f.seek(0)
  records.append({'file':p.name,'bytes':info.st_size,'sha256':h,'width':video['width'],'height':video['height'],'duration_s':duration,'audio':True,'full_decode':'passed'})
 print(json.dumps({'videos':records}))
finally:
 for f in opened:f.close()
