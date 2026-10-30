// One-shot, syntax-aware mechanical migration of product presentation strings.
// Does not change network requests, authorization, state machines or user content.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,readdirSync,realpathSync} from 'node:fs';
import {resolve,relative,dirname} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const req=createRequire(realpathSync(resolve(root,'apps/web/node_modules/vite/package.json')));
const {parseAst}=await import(req.resolve('rolldown/parseAst'));
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>['node_modules','vendor','dist'].includes(e.name)?[]:e.isDirectory()?files(resolve(dir,e.name)):/\.(tsx?|m?js)$/.test(e.name)?[resolve(dir,e.name)]:[]);}
const paths=files(resolve(root,'apps/web/src'));
for(const e of readdirSync(resolve(root,'apps'),{withFileTypes:true}))if(e.isDirectory()&&e.name.endsWith('-plugin')){try{paths.push(...files(resolve(root,'apps',e.name,'src/public')));}catch{}}
const str=n=>n?.type==='Literal'&&typeof n.value==='string'?n.value:null;
const han=s=>/[\u3400-\u9fff]/.test(s??'');
function template(n){if(str(n)!==null)return {text:str(n),expressions:[]};if(n?.type==='TemplateLiteral')return {text:n.quasis.map((q,i)=>q.value.cooked+(i<n.expressions.length?`{v${i}}`:'')).join(''),expressions:n.expressions};return null;}
for(const path of paths){
 let source=readFileSync(path,'utf8');if(source.includes('product-localization.mjs')||path.endsWith('/i18n.ts')||path.endsWith('/AppearancePreferences.tsx')||path.endsWith('/theme-prepaint.js'))continue;
 const ast=parseAst(source,{lang:/\.tsx?$/.test(path)?'tsx':'js'},path),edits=[],imports=new Set();
 const web=path.includes('/web/'),locale=web?'locale':path.endsWith('/casting-client-v1.mjs')||path.endsWith('/computers.mjs')?'locale':path.endsWith('/app.js')?'state.locale':'document.documentElement.lang';
 const src=n=>source.slice(n.start,n.end),put=(n,text)=>edits.push([n.start,n.end,text]);
 function walk(n){
  if(n.type==='VariableDeclarator'&&['messages','catalog','words'].includes(n.id?.name)){
   const init=n.init?.type==='TSAsExpression'?n.init.expression:n.init;
   if(init?.type==='ObjectExpression'&&init.properties.some(p=>(p.key?.name??str(p.key))==='en')){edits.push([init.start,init.start,'localizedCatalogs('],[init.end,init.end,')']);imports.add('localizedCatalogs');}
  }
  if(n.type==='ConditionalExpression'){
   const a=template(n.consequent),b=template(n.alternate),test=src(n.test);
   if(str(n.consequent)==='en'&&str(n.alternate)==='zh-CN'&&n.test.type==='BinaryExpression'&&str(n.test.right)==='en'){
    put(n,`normalizeProductLocale(${src(n.test.left)})`);imports.add('normalizeProductLocale');return;
   }
   if(a&&b&&han(a.text)!==han(b.text)&&(/locale|lang/.test(test)||['zh','en'].includes(test))){
    const english=han(a.text)?b:a,chinese=han(a.text)?a:b;
    const values=english.expressions.length?`, {${english.expressions.map((e,i)=>`v${i}: ${src(e)}`).join(', ')}}`:'';
    put(n,`productText(${locale}, ${JSON.stringify(english.text)}, ${JSON.stringify(chinese.text)}${values})`);imports.add('productText');return;
   }
  }
  if(n.type==='AssignmentExpression'&&src(n.left)==='document.documentElement.dir'&&str(n.right)==='ltr'){
   put(n.right,`productLocaleDirection(${locale})`);imports.add('productLocaleDirection');return;
  }
  for(const v of Object.values(n)){if(Array.isArray(v)){for(const c of v)if(c?.type)walk(c);}else if(v?.type)walk(v);}
 }
 walk(ast);if(!edits.length)continue;
 for(const[start,end,value]of edits.sort((a,b)=>b[0]-a[0]||b[1]-a[1]))source=source.slice(0,start)+value+source.slice(end);
 let from=web?relative(dirname(path),resolve(root,'packages/ui-system/src/product-localization.mjs')):'./product-localization.mjs';if(!from.startsWith('.'))from='./'+from;
 source=`import { ${[...imports].join(', ')} } from ${JSON.stringify(from)};\n`+source;
 writeFileSync(path,source);console.log(relative(root,path),edits.length);
}
