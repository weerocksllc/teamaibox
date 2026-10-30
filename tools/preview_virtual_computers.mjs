// Local, read-only visual fixture. No connection to a node, Windows or product DB.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const root=new URL('../apps/virtual-computers-plugin/src/public/',import.meta.url);
const files=new Set(['index.html','computers.css','computers.mjs','computer-client.mjs','theme-prepaint.js']);
const id='10000000-0000-4000-8000-000000000001';
const systems=[{id:'win11-preview',name:'Windows 11',edition:'Pro',createEnabled:true,minimum:{vcpus:2,memoryGiB:4,diskGiB:64}},
 {id:'win10-preview',name:'Windows 10',edition:'Pro',createEnabled:false,minimum:{vcpus:2,memoryGiB:4,diskGiB:64}}];
const data=[{id,name:'工作电脑 · 界面测试',state:'running',revision:1,system:systems[0],resources:{vcpus:4,memoryBytes:8*1024**3,diskBytes:128*1024**3}},
 {id:'20000000-0000-4000-8000-000000000002',name:'Project workspace · preview',state:'stopped',revision:1,system:systems[0],resources:{vcpus:8,memoryBytes:16*1024**3,diskBytes:256*1024**3}}];
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(req.method!=='GET'){res.writeHead(405);res.end('Read-only visual fixture');return;}
  if(path==='/api/v1/virtual-computers'||path==='/api/v1/virtual-computers/availability'){
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(path.endsWith('availability')?{enabled:true,systems,limits:{maximum:{}}}:{data}));return;
  }
  const name=path==='/'?'index.html':path.split('/').at(-1);
  try{
    const source=name==='preferences-v1.mjs'?new URL('../packages/plugin-sdk/src/preferences-v1.mjs',import.meta.url):files.has(name)?new URL(name,root):null;
    if(!source)throw Error('not found');let content=await readFile(source);
    if(name==='index.html')content=Buffer.from(content.toString().replace('<body>','<body><aside style="padding:8px 24px;background:#f4e3b9;color:#473400;font:14px system-ui">界面预览 / Visual fixture — 非线上电脑，操作不会执行</aside>'));
    res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':'text/javascript');res.end(content);
  }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(`Visual fixture: http://127.0.0.1:${server.address().port}/\n`));
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>server.close(()=>process.exit(0)));
