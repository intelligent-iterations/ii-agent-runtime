import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
// Replace the checkout link before npm resolves a copied, standalone package.
export function bindRuntime(directory,spec){
  const name='@intelligent-iterations/ii-agent-runtime';
  const manifestPath=join(directory,'package.json');
  const lockPath=join(directory,'package-lock.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const lock=JSON.parse(readFileSync(lockPath,'utf8'));
  const installed='node_modules/'+name;
  const previous=lock.packages[installed];
  if(previous?.link&&typeof previous.resolved==='string')delete lock.packages[previous.resolved];
  delete lock.packages[installed];
  manifest.dependencies[name]=spec;
  lock.packages[''].dependencies[name]=spec;
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  writeFileSync(lockPath,JSON.stringify(lock,null,2)+'\n');
}
