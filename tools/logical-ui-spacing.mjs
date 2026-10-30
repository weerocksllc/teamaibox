// Mechanical presentation-only spacing migration. Guest/absolute geometry is untouched.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>['vendor','node_modules','dist'].includes(e.name)?[]:e.isDirectory()?files(resolve(dir,e.name)):e.name.endsWith('.css')?[resolve(dir,e.name)]:[]);}
const paths=[...files(resolve(root,'apps/web/src')),...files(resolve(root,'packages/ui-system/src'))];
for(const e of readdirSync(resolve(root,'apps'),{withFileTypes:true}))if(e.isDirectory()&&e.name.endsWith('-plugin')){try{paths.push(...files(resolve(root,'apps',e.name,'src/public')));}catch{}}
for(const path of paths){const source=readFileSync(path,'utf8');const result=source.replace(/\b(margin|padding|border)-(left|right)(-width|-style|-color)?\s*:/g,(_,property,side,suffix='')=>`${property}-inline-${side==='left'?'start':'end'}${suffix}:`).replace(/\btext-align:\s*(left|right)\b/g,(_,side)=>`text-align: ${side==='left'?'start':'end'}`);if(result!==source)writeFileSync(path,result);}
