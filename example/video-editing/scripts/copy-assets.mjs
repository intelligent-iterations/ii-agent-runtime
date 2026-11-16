import {copyFileSync,mkdirSync} from 'node:fs';
mkdirSync(new URL('../dist/src/',import.meta.url),{recursive:true});
for(const name of ['archive.py','collect.py','export.py','render.py'])copyFileSync(new URL('../src/'+name,import.meta.url),new URL('../dist/src/'+name,import.meta.url));
