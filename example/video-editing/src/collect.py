"""Collect candidate bytes only. Nothing returned by the renderer is trusted.

A known problem prints {"error": code, ...} and exits 0, so the coordinator can name
the fix; it maps known codes to its own messages and never shows this output."""
import json,os,stat,sys,tarfile
from pathlib import Path
limit=int(sys.argv[1]);count=int(sys.argv[2]);root=Path('/workspace/repository/out')
def fail(code,**extra):
 print(json.dumps({'error':code,**extra}));sys.exit(0)
if root.is_symlink() or not root.is_dir():fail('no-out')
total=0;seen=0
with tarfile.open('/workspace/candidates.tar','w',format=tarfile.USTAR_FORMAT) as archive:
 for p in root.iterdir():
  if p.suffix!='.mp4':continue
  seen+=1
  if seen>count:fail('too-many')
  try:fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  except OSError:fail('not-regular')
  with os.fdopen(fd,'rb') as f:
   info=os.fstat(fd)
   if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:fail('not-regular')
   total+=info.st_size
   if total>limit:fail('too-large')
   entry=tarfile.TarInfo(p.name);entry.size=info.st_size;entry.mode=0o600;archive.addfile(entry,f)
if seen!=count:fail('too-few',found=seen)
print(json.dumps({'ok':True}))
