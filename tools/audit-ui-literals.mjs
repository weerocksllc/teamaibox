import {createRequire} from 'node:module';
import {realpathSync,readFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
const root=resolve(import.meta.dirname,'..'),req=createRequire(realpathSync(resolve(root,'apps/web/node_modules/vite/package.json'))),{parseAst}=await import(req.resolve('rolldown/parseAst'));
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>['vendor','node_modules'].includes(e.name)?[]:e.isDirectory()?files(resolve(dir,e.name)):/\.(?:tsx?|m?js)$/.test(e.name)?[resolve(dir,e.name)]:[]);}
const paths=files(resolve(root,'apps/web/src'));for(const e of readdirSync(resolve(root,'apps'),{withFileTypes:true}))if(e.isDirectory()&&e.name.endsWith('-plugin')){try{paths.push(...files(resolve(root,'apps',e.name,'src/public')));}catch{}}
for(const path of paths){const source=readFileSync(path,'utf8'),ast=parseAst(source,{lang:/\.tsx?$/.test(path)?'tsx':'js'},path);
 const emit=n=>console.log(relative(root,path)+':'+source.slice(0,n.start).split('\n').length+' '+source.slice(n.start,n.end));
 function walk(n){
  if(n.type==='AssignmentExpression'&&['textContent','placeholder','title'].includes(n.left?.property?.name)&&['Literal','TemplateLiteral'].includes(n.right.type)&&/[A-Za-z\u3400-\u9fff]/.test(source.slice(n.right.start,n.right.end)))emit(n);
  if(n.type==='JSXText'&&/[A-Za-z\u3400-\u9fff]/.test(n.value.trim()))emit(n);
  for(const value of Object.values(n)){if(Array.isArray(value)){for(const child of value)if(child?.type)walk(child);}else if(value?.type)walk(value);}
 }walk(ast);
}
