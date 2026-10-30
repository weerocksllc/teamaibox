import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export function phonePluginPolicy(runtime, policy) {
  assert.deepEqual(runtime.capabilities, ['object-references','nvidia-container-runtime']);
  assert(!policy.permissions.allowedPlatformApiScopes.includes('phone:use'));
  const nextRuntime=structuredClone(runtime), nextPolicy=structuredClone(policy);
  nextRuntime.capabilities.push('encrypted-objects');
  nextPolicy.permissions.allowedPlatformApiScopes.push('phone:use');
  return {runtime:nextRuntime,policy:nextPolicy};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const files=['plugin-runtime.json','plugin-import-policy.json'];
  const expected=['9ed3cffd00d1725005040701bfa006f7ada91f3c32e9d5a6402f85a946f59103','b39e5a575654e191376a2514b65c52b08207f742772ac8f1f0371556711e6633'];
  const raw=await Promise.all(files.map(f=>readFile('/opt/teamaibox/config/'+f)));
  raw.forEach((v,i)=>assert.equal(createHash('sha256').update(v).digest('hex'),expected[i]));
  const {runtime,policy}=phonePluginPolicy(...raw.map(v=>JSON.parse(v)));
  for(const [i,value] of [runtime,policy].entries())await writeFile('/opt/teamaibox/config/'+files[i],JSON.stringify(value)+'\n');
}

