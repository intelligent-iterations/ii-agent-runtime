"""Trusted coordinator: accept bounded regular MP4 members and rebuild the tar.

Never execute or extract archive paths/metadata. Media decoding runs elsewhere.
"""
import hashlib,json,os,re,sys,tarfile
from pathlib import Path
source,destination,output=map(Path,sys.argv[1:4]);limit,count=map(int,sys.argv[4:6])
if source.stat().st_size>limit+1048576:raise ValueError('Archive exceeds export limit')
destination.mkdir(mode=0o700);root=destination/'out';root.mkdir(mode=0o700)
records=[];seen=set();total=0
with tarfile.open(source,'r|') as archive:
 for member in archive:
  name=member.name
  if (len(records)>=count or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._ -]{0,94}\.mp4',name)
      or member.type!=tarfile.REGTYPE or member.linkname or member.sparse is not None
      or member.pax_headers or name.casefold() in seen):raise ValueError('Unsafe or unexpected archive member')
  total+=member.size
  if member.size<1 or total>limit:raise ValueError('Videos exceed export limit')
  seen.add(name.casefold());h=hashlib.sha256();remaining=member.size
  with archive.extractfile(member) as data, (root/name).open('xb') as target:
   os.chmod(root/name,0o600)
   while remaining:
    chunk=data.read(min(65536,remaining))
    if not chunk:raise ValueError('Truncated archive member')
    target.write(chunk);h.update(chunk);remaining-=len(chunk)
  records.append({'file':name,'bytes':member.size,'sha256':h.hexdigest()})
if len(records)!=count:raise ValueError('Incorrect video count')
with output.open('xb') as stream:
 os.chmod(output,0o600)
 with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT) as archive:
  for record in sorted(records,key=lambda r:r['file']):
   entry=tarfile.TarInfo(record['file']);entry.size=record['bytes'];entry.mode=0o600
   with (root/record['file']).open('rb') as data:archive.addfile(entry,data)
print(json.dumps({'videos':records,'archive_bytes':output.stat().st_size}))
