// Small USTAR fixtures; the production parser/repacker uses Python's tarfile.
export function tarBuffer(entries:{name:string;data?:Buffer;type?:string;link?:string;size?:number}[]):Buffer {
  const chunks:Buffer[]=[];
  for(const entry of entries){
    const data=entry.data??Buffer.alloc(0),header=Buffer.alloc(512);
    header.write(entry.name,0,100);header.write('0000600\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
    header.write((entry.size??data.length).toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);
    header.fill(32,148,156);header.write(entry.type??'0',156);header.write(entry.link??'',157,100);
    header.write('ustar\0',257);header.write('00',263);
    let sum=0;for(const byte of header)sum+=byte;header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
    chunks.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  chunks.push(Buffer.alloc(1024));return Buffer.concat(chunks);
}
