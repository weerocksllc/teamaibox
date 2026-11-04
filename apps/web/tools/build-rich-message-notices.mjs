// Generate bundled notices from the installed, locked rendering dependency tree.
import {createRequire} from 'node:module';
import {readFile,readdir,realpath,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const app=fileURLToPath(new URL('..',import.meta.url));
const roots=['streamdown','@streamdown/math','highlight.js','mermaid','dompurify','katex'];
const packages=new Map();
const sources=JSON.parse(await readFile(join(app,'third-party/rich-message-license-sources.json'),'utf8'));
async function visit(name,parent){
  const require=createRequire(join(parent,'package.json'));let root;
  for(const location of require.resolve.paths(name)??[]){try{root=await realpath(join(location,name));await readFile(join(root,'package.json'));break;}catch{root=undefined;}}
  if(!root)throw Error('Rendering dependency missing: '+name);
  const metadata=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const key=metadata.name+'@'+metadata.version;if(packages.has(key))return;
  const texts=[];packages.set(key,{name:metadata.name,version:metadata.version,license:metadata.license??'UNKNOWN',texts});
  for(const entry of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(entry.isFile()&&/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name))texts.push({file:entry.name,text:await readFile(join(root,entry.name),'utf8')});
  }
  if(!texts.length){
    const fallback=sources[key]??(/^micromark-(?:util|factory)-/.test(metadata.name)&&metadata.version==='2.0.0'?sources['micromark@2.0.0-family']:undefined);
    if(fallback)texts.push({file:fallback.source,text:await readFile(join(app,'third-party',fallback.file),'utf8')});
  }
  // This exact package omits package.json's license field but supplies MIT text.
  if(key==='khroma@2.1.0'&&texts.some(t=>t.file==='license'&&t.text.startsWith('The MIT License (MIT)')))packages.get(key).license='MIT';
  for(const dependency of Object.keys(metadata.dependencies??{}).sort())await visit(dependency,root);
}
for(const name of roots)await visit(name,app);
const rows=[...packages.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
const missing=rows.filter(row=>!row.texts.length).map(row=>row.name+'@'+row.version);
if(missing.length)throw Error('Missing rendering license text: '+missing.join(', '));
const output=['Team AI Box — bundled rich-message rendering dependencies',
  'Original upstream licenses apply. This notice is not a grant of a new license.',
  ...rows.map(row=>['\n===== '+row.name+'@'+row.version+' | '+row.license+' =====',...row.texts.map(file=>'\n--- '+file.file+' ---\n'+file.text),...(!row.texts.length?['No license text supplied in this installed package. See its declared upstream license.']:[])].join('\n'))].join('\n')+'\n';
await mkdir(join(app,'public/licenses'),{recursive:true});
await writeFile(join(app,'public/licenses/rich-messages.txt'),output);
console.log(JSON.stringify({renderingPackages:rows.length,packagesWithoutLicenseText:missing}));
