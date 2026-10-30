// Isolated disposable UI workflow. Production markup, styles, JS, HTTP API and
// service; two in-memory identities. Never connects to the appliance/user data.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MemoryMessagingRepository } from '../../../services/messaging/src/memory-repository.mjs';
import { MessagingService } from '../../../services/messaging/src/messaging-service.mjs';
import { MessagingHttpApi } from '../../platform-api/src/messaging/messaging-http-api.mjs';
import { applicationPluginSharedAsset } from '../../../packages/application-plugin-runtime/src/static-server.mjs';

const alice=randomUUID(), bob=randomUUID();
const people=[{id:alice,username:'cleanup-test-a',display_name:'清理测试 A'},{id:bob,username:'cleanup-test-b',display_name:'清理测试 B'}];
const context=id=>({identityId:id,permissions:['message:read','message:write','message:manage']});
const actor=id=>({actorIdentityId:id,actorKind:'local_user',permissions:context(id).permissions});
const service=new MessagingService({repository:new MemoryMessagingRepository(),attachmentVerifier:{resolveAttachment(){},issueDownloadReference(){}}});
const api=new MessagingHttpApi({service});
const conversation=await service.createConversation(actor(alice),{kind:'direct',participantIdentityIds:[alice,bob]});
for(let i=1;i<=35;i++)await service.sendMessage(actor(i%2?alice:bob),conversation.id,{idempotencyKey:`fixture-${i}`,content:`可丢弃测试消息 ${i} — 检查历史滚动，绝不使用现有用户数据。`});
const listTarget=await service.createConversation(actor(alice),{kind:'group',title:'列表删除专用测试',participantIdentityIds:[alice,bob]});
await service.sendMessage(actor(bob),listTarget.id,{idempotencyKey:'fixture-list-delete',content:'只删除此测试聊天，不影响当前打开的另一条聊天。'});
const root=new URL('../src/public/',import.meta.url);
const hostStyles=(await readFile(new URL('../../web/src/styles.css',import.meta.url),'utf8'));
const host=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Safari 消息清理测试（隔离数据）</title>
<style>${hostStyles}</style><style>:root{--sidebar-width:0px}body{margin:0}#fixture-banner{height:64px;padding:12px;background:#e4f3f1;color:#173033;font:16px system-ui}#fixture-result{position:fixed;bottom:0;left:0;font:11px monospace;pointer-events:none;z-index:100;background:#fff}</style>
<header id="fixture-banner">仅可丢弃测试数据 · <a href="/?actor=b">切换到测试 B</a> · <a href="/">切换到测试 A</a></header>
<section class="plugin-workspace"><header class="plugin-workspace__header">即时通信 · Safari 验证</header><iframe title="即时通信" class="plugin-workspace__frame" src="/plugins/official.messaging/" sandbox="allow-same-origin allow-scripts allow-forms"></iframe></section>
<output id="fixture-result"></output><script>setInterval(()=>{const f=document.querySelector('iframe'),d=f.contentDocument,c=d?.querySelector('#composer'),i=d?.querySelector('#message-input');if(!c||c.closest('[hidden]'))return;const frame=f.getBoundingClientRect(),r=c.getBoundingClientRect(),ir=i.getBoundingClientRect();const result={viewport:innerHeight,frameBottom:frame.bottom,frameHeight:frame.height,composerBottom:frame.top+r.bottom,inputBottom:frame.top+ir.bottom,visible:frame.top+r.bottom<=innerHeight+1};document.querySelector('output').textContent=JSON.stringify(result);fetch('/fixture/measurement',{method:'POST',body:JSON.stringify(result)});},1500);</script></html>`;
let lastMeasurement;
createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1'); const path=url.pathname;
  const user=(req.headers.cookie??'').includes('fixtureActor=b')?bob:alice;
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))};
  if(path==='/'){res.writeHead(200,{'content-type':'text/html','set-cookie':[`fixtureActor=${url.searchParams.get('actor')==='b'?'b':'a'}; Path=/`,'cleanup-fixture=only-test-data; Path=/']});res.end(host);return}
  if(path==='/fixture/measurement'){
   if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;lastMeasurement=JSON.parse(raw);json({ok:true})}else json(lastMeasurement??{});return;
  }
  if(path==='/api/v1/session/bootstrap'){json({actor:{identity_id:user}});return}
  if(path.startsWith('/api/v1/identities')){json({data:people,meta:{actorIdentityId:user,nextOffset:null}});return}
  if(path.startsWith('/plugins/official.messaging')){
   const asset=path.split('/').at(-1)||'index.html';if(!/^[a-z0-9.-]+$/.test(asset)){res.writeHead(404);res.end();return}
   const shared=applicationPluginSharedAsset(asset);let data=shared?.body??await readFile(new URL(asset,root));
   if(asset==='app.js')data=data.toString().replaceAll('__Host-teamaibox-csrf=','cleanup-fixture=');
   const type=asset.endsWith('.css')?'text/css':asset.endsWith('.html')?'text/html':'text/javascript';
   res.writeHead(200,{'content-type':`${type}; charset=utf-8`,'cache-control':'no-store'});res.end(data);return;
  }
  if(api.matches(req.method,path)){
   let raw='';for await(const chunk of req)raw+=chunk;
   const controller=new AbortController();res.on('close',()=>controller.abort());
   const result=await api.handle({method:req.method,pathname:path,query:url.searchParams,body:raw?JSON.parse(raw):null,headers:req.headers,context:context(user),signal:controller.signal});
   if(result.kind==='sse'){res.writeHead(200,{'content-type':'text/event-stream'});for await(const event of result.events){res.write(`id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event.data)}\n\n`)}res.end()}
   else json(result.body,result.status);return;
  }
  json({error:{message:'Not found'}},404);
 }catch(error){res.writeHead(error.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message,code:error.code}}));}
}).listen(4191,'127.0.0.1',()=>console.log('Disposable messaging workflow: http://127.0.0.1:4191'));
