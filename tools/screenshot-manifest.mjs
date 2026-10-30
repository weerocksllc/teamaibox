import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {localeDefinitions} from '../packages/ui-system/src/locale-registry.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../docs/assets/screenshots');
const images=[];
for(const {code} of localeDefinitions)for(const theme of ['light','dark']){
  const relative=`${code}/workbench-${theme}.jpg`;
  const data=await fs.readFile(path.join(root,relative));
  if(data[0]!==255||data[1]!==216)throw new Error(`Not JPEG: ${relative}`);
  images.push({locale:code,theme,page:'workbench',file:relative,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
}
const manifest=JSON.stringify({schemaVersion:1,source:'Actual product UI; demonstration account',images},null,2)+'\n';
const target=path.join(root,'manifest.json');
if(process.argv.includes('--check')){if(await fs.readFile(target,'utf8')!==manifest)throw new Error('Screenshot manifest is stale');}
else await fs.writeFile(target,manifest);
console.log(`Verified ${images.length} localized theme images.`);
