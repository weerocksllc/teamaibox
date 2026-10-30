// Mechanical registry/type/manifest synchronization, not application behavior.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,relative,dirname} from 'node:path';
import {supportedLocaleCodes} from '../packages/ui-system/src/locale-registry.mjs';
const root=resolve(import.meta.dirname,'..');
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>['node_modules','dist','vendor'].includes(e.name)?[]:e.isDirectory()?walk(resolve(dir,e.name)):[resolve(dir,e.name)]);}
for(const path of walk(resolve(root,'apps/web/src'))){if(!/\.(?:tsx?|mjs)$/.test(path))continue;let s=readFileSync(path,'utf8'),old=s;
 if(s.includes('"zh-CN" | "en"')){
  const registry=relative(dirname(path),resolve(root,'packages/ui-system/src/locale-registry.mjs'));
  s=s.replaceAll('"zh-CN" | "en"',path.endsWith('.mjs')?`import("${registry}").ProductLocale`:'ProductLocale');
  if(!path.endsWith('.mjs'))s=`import type { ProductLocale } from "${registry}";\n`+s;
 }
 if(/supportedLocales:.*\["zh-CN", "en"\]/.test(s)){
  s=s.replaceAll('["zh-CN", "en"]',JSON.stringify(supportedLocaleCodes)).replaceAll('Object.freeze(["ltr"]','Object.freeze(["ltr", "rtl"]').replaceAll('rtlReady: false','rtlReady: true');
 }
 if(s!==old){writeFileSync(path,s);console.log(relative(root,path));}
}
for(const e of readdirSync(resolve(root,'apps'),{withFileTypes:true}))if(e.isDirectory()&&e.name.endsWith('-plugin')){
 const path=resolve(root,'apps',e.name,'manifest.release-template.json');try{const text=readFileSync(path,'utf8'),data=JSON.parse(text);if(!data.localization)continue;data.localization.supportedLocales=[...supportedLocaleCodes];data.localization.supportedDirections=['ltr','rtl'];data.localization.rtlReady=true;writeFileSync(path,JSON.stringify(data,null,2)+'\n');console.log(relative(root,path));}catch{}
}
