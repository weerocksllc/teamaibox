// Static product-copy inventory. Never executes application modules or reads user data.
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
const req=createRequire(realpathSync(new URL('../apps/web/node_modules/vite/package.json',import.meta.url)));
const {parseAst}=await import(req.resolve('rolldown/parseAst'));
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {resolve, relative} from 'node:path';
const root=resolve(import.meta.dirname,'..');
async function files(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){if(['node_modules','vendor','dist'].includes(e.name))continue;const p=resolve(dir,e.name);if(e.isDirectory())out.push(...await files(p));else if(/\.(?:tsx?|m?js|html)$/.test(p))out.push(p);}return out;}
const paths=[...await files(resolve(root,'apps/web/src'))];
for(const e of await readdir(resolve(root,'apps'),{withFileTypes:true}))if(e.isDirectory()&&e.name.endsWith('-plugin')){try{paths.push(...await files(resolve(root,'apps',e.name,'src/public')));}catch{}}
const entries=[],bilingual=[],inline=[],raw=[];
const name=n=>n?.type==='Identifier'?n.name:n?.type==='Literal'?n.value:null;
const value=n=>n?.type==='Literal'&&typeof n.value==='string'?n.value:n?.type==='TemplateLiteral'&&!n.expressions.length?n.quasis[0].value.cooked:null;
function children(n,visit){for(const v of Object.values(n)){if(Array.isArray(v)){for(const x of v)if(x?.type)visit(x);}else if(v?.type)visit(v);}}
function object(n){if(n?.type==='TSAsExpression')return object(n.expression);if(n?.type==='CallExpression'&&name(n.callee)==='localizedCatalogs')return object(n.arguments[0]);if(n?.type!=='ObjectExpression')return null;const v={};for(const p of n.properties){if(p.type!=='Property')continue;const k=name(p.key),x=value(p.value)??object(p.value);if(k!==null&&x!==null)v[k]=x;}return v;}
function access(n){if(n?.type==='Identifier')return [n.name];if(n?.type==='MemberExpression')return [...access(n.object),n.computed?value(n.property):name(n.property)];return [];}
for(const path of paths){if(path.endsWith('.html')){const source=await readFile(path,'utf8');for(const match of source.matchAll(/(?:data-en|data-ui-copy)="([^"]+)"[^>]*>([^<]*)</g))inline.push({file:relative(root,path),en:match[1].replaceAll('&amp;','&'),zh:match[2]});continue;}const source=await readFile(path,'utf8'),sf=parseAst(source,{lang:/\.tsx?$/.test(path)?'tsx':'js'},path),catalogs=new Map(),seen=new Set();
 const key=relative(root,path);
 function walk(n){
  if(n.type==='VariableDeclarator'&&['messages','catalog','words','ENGLISH','zhCN','en'].includes(name(n.id))){const v=object(n.init);if(v){catalogs.set(name(n.id),v);mark(n.init);}}
  if(n.type==='AssignmentExpression'&&n.operator==='='){const p=access(n.left),v=value(n.right);if(p.length===3&&catalogs.has(p[0])&&v!==null){(catalogs.get(p[0])[p[1]]??={})[p[2]]=v;mark(n.right);}}
  if(n.type==='CallExpression'&&access(n.callee).join('.')==='Object.assign'){const p=access(n.arguments[0]),v=object(n.arguments[1]);if(p.length===2&&catalogs.has(p[0])&&v){Object.assign(catalogs.get(p[0])[p[1]]??={},v);mark(n.arguments[1]);}}
  if(n.type==='CallExpression'){
   const args=n.arguments.map(value),fn=name(n.callee);
   if(fn==='productText'&&args[1]!==null){inline.push({file:key,line:source.slice(0,n.start).split('\n').length,en:args[1],zh:args[2]});n.arguments.slice(1,3).forEach(mark);}
   else if(['t','tr','text'].includes(fn)&&args[0]&&args[1]&&/[\u3400-\u9fff]/.test(args[0])&&!/[\u3400-\u9fff]/.test(args[1])){inline.push({file:key,line:source.slice(0,n.start).split('\n').length,en:args[1],zh:args[0]});n.arguments.slice(0,2).forEach(mark);}
  }
  if(n.type==='ConditionalExpression'){const a=value(n.consequent),b=value(n.alternate);if(a!==null&&b!==null&&(/[\u3400-\u9fff]/.test(a)!==/[\u3400-\u9fff]/.test(b))){const en=/[\u3400-\u9fff]/.test(a)?b:a,zh=en===a?b:a;bilingual.push({file:key,line:source.slice(0,n.start).split('\n').length,condition:source.slice(n.test.start,n.test.end),en,zh});mark(n.consequent);mark(n.alternate);}}
  children(n,walk);
 }
 function mark(n){seen.add(n);children(n,mark);}
 walk(sf);
 for(const [id,c]of catalogs){const en=id==='en'?c:id==='ENGLISH'?c:c.en,zh=id==='zhCN'?c:(c['zh-CN']??c.zh);if(en||zh)entries.push({file:key,id,en:en??{},zh:zh??{}});}
 function rawWalk(n){const v=value(n);if(v&&/[\u3400-\u9fff]/.test(v)&&!seen.has(n))raw.push({file:key,line:source.slice(0,n.start).split('\n').length,text:v});children(n,rawWalk);}rawWalk(sf);
}
const texts=[...new Set([...entries.flatMap(e=>Object.values(e.en).filter(v=>typeof v==='string')),...bilingual.map(e=>e.en),...inline.map(e=>e.en)])].sort();
const report={version:1,catalogs:entries,bilingual,inline,raw,sourceTexts:texts};
const dest=resolve(root,'docs/validation/global-localization-inventory-20261023.json');await mkdir(resolve(root,'docs/validation'),{recursive:true});await writeFile(dest,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({catalogs:entries.map(e=>({file:e.file,id:e.id,english:Object.keys(e.en).length,chinese:Object.keys(e.zh).length})),bilingual:bilingual.length,raw:raw.length,uniqueSourceTexts:texts.length,report:dest},null,2));
