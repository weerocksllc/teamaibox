import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {localeDefinitions} from '../packages/ui-system/src/locale-registry.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p));
for(const [name,size] of [['docs/assets/brand/mascot-master.png',1254],['docs/assets/brand/mascot.png',512],['apps/web/public/brand/mascot.png',256],['apps/web/public/brand/favicon.png',64],['apps/web/public/brand/touch-icon.png',180]]){
  const data=read(name);
  assert.equal(data.subarray(1,4).toString(),'PNG',name);
  assert.equal(data.readUInt32BE(16),size,name);
  assert.equal(data.readUInt32BE(20),size,name);
  assert.equal(data[25],6,`${name}: preserve RGBA transparency`);
}
for(const {code} of localeDefinitions){
  const text=read(code==='en'?'README.md':`README.${code}.md`).toString();
  assert.equal(text.split('src="docs/assets/brand/mascot.png"').length,2,code);
}
for(const file of ['apps/web/src/App.tsx','apps/web/src/auth/AuthenticatedApp.tsx','apps/web/src/auth/AuthShowcase.tsx']){
  const text=read(file).toString();
  assert.match(text,/<BrandLogo/);
  assert.doesNotMatch(text,/<Command\b/);
}
assert.match(read('apps/web/index.html').toString(),/href="\/brand\/favicon.png"/);
assert.match(read('apps/web/src/BrandLogo.tsx').toString(),/alt=""/);
console.log('Brand assets: transparent PNG sizes, 17 README headers, shared product logo and favicon passed.');
