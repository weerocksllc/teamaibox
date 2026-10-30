// Isolated two-user browser workflow, using the production monitor toolbar,
// sharing dialog/module, invitation list and websocket control gateway.
// Synthetic display only: no live guest, account or appliance data.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {ComputerDesktopAccess} from '../src/virtual-computers/desktop-access.mjs';
import {applicationPluginSharedAsset} from '../../../packages/application-plugin-runtime/src/static-server.mjs';
const id='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',guest='33333333-3333-4333-8333-333333333333';
const people=[{id:owner,displayName:'测试主人',username:'test-owner'},{id:guest,displayName:'测试成员',username:'test-member'}],grants=new Map();
const context=user=>({identityId:user,sessionId:user});
const denied=()=>{throw Object.assign(Error('Denied'),{code:'computer_not_found',status:404});};
const sharing={async resolve({context:c}){if(c.identityId!==owner&&!grants.has(c.identityId))denied();return {id,ownerId:owner,state:'running',runId:id,monitorRole:c.identityId===owner?'owner':grants.get(c.identityId),actorName:people.find(p=>p.id===c.identityId).displayName};},
 async grants(c){if(c.identityId!==owner)denied();return {data:[...grants].map(([identityId,permission])=>({...people.find(p=>p.id===identityId),identityId,permission}))};},
 async update(c,computerId,body){if(c.identityId!==owner||computerId!==id)denied();if(body.permission===null)grants.delete(body.identityId);else grants.set(body.identityId,body.permission);return this.grants(c);},
 async invitations(c){return {data:grants.has(c.identityId)?[{id,name:'可丢弃共享测试电脑',state:'running',permission:grants.get(c.identityId),ownerName:'测试主人'}]:[]};}};
const upstream=createServer(),wss=new WebSocketServer({server:upstream});
wss.on('connection',ws=>ws.on('message',bytes=>ws.send(bytes.toString())));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const api=new ComputerDesktopAccess({sharing,resolveOwnedComputer:async()=>({id,ownerId:owner,state:'running',runId:id}),provider:{async connect(){const ws=new WebSocket(`ws://127.0.0.1:${upstream.address().port}`);await once(ws,'open');ws.pause();return ws;}}});
const root=new URL('../../virtual-computers-plugin/src/public/',import.meta.url);
const script=`import {mountMonitorSharing} from '/plugins/official.virtual-computers/monitor-sharing.mjs';
const base='/api/v1/virtual-computers/${id}',state=document.querySelector('#status');let ws;
const panel=mountMonitorSharing({base,onControl:allowed=>document.querySelector('#screen').dataset.control=String(allowed)});
document.querySelector('#view-title').textContent='隔离共享测试 · 无真实虚拟机';
async function open(){const r=await fetch(base+'/desktop-sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{"mode":"console"}'});if(!r.ok){state.textContent='未受邀请 / 邀请已撤销';return;}const s=await r.json();
const q=new URLSearchParams({token:s.authToken,GUAC_DATA_SOURCE:'json',GUAC_ID:'${id}',GUAC_TYPE:'c',GUAC_WIDTH:'1024',GUAC_HEIGHT:'768',GUAC_DPI:'96',GUAC_TIMEZONE:'UTC'});
ws=new WebSocket('ws://'+location.host+base+'/desktop-tunnel?'+q,'guacamole');ws.onopen=()=>{state.textContent='已连接（测试画面）';panel.join(s.viewerId)};ws.onclose=()=>{panel.leave();state.textContent='连接已关闭 / 权限已收回'};}
document.querySelector('#leave').onclick=()=>ws?.close();document.querySelector('#reconnect').onclick=open;document.querySelector('#sound').hidden=true;document.querySelector('#fullscreen').hidden=true;open();`;
for(const [user,port] of [[owner,4196],[guest,4197]]){
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),path=url.pathname,c=context(user);
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  try{
   if(api.matches(req.method,path)){let raw='';for await(const b of req)raw+=b;const r=await api.handle({method:req.method,pathname:path,context:c,query:url.searchParams,body:raw?JSON.parse(raw):null});json(r.body,r.status);return;}
   if(path==='/api/v1/virtual-computers/availability'){json({enabled:false,systems:[],limits:{maximum:{}},reasonCode:'computer_creation_paused'});return;}
   if(path==='/api/v1/virtual-computers'){json({data:[]});return;}
   if(path.startsWith('/api/v1/identities/')){json({data:people,meta:{actorIdentityId:user,nextOffset:null}});return;}
   if(path==='/fixture.mjs'){res.writeHead(200,{'content-type':'text/javascript'});res.end(script);return;}
   const asset=path==='/'?'desktop.html':path==='/list'?'index.html':path.split('/').at(-1);
   if(!/^[a-z0-9.-]+$/.test(asset))denied();
   const shared=applicationPluginSharedAsset(asset);let body=shared?.body??await readFile(new URL(asset,root));
   if(asset==='desktop.html')body=body.toString().replace(/<script src="(?:guacamole-common-js\/all.min.js|desktop-diagnostics.js)"><\/script>/g,'').replace('src="desktop.mjs?v=sharing-20261022"','src="/fixture.mjs"').replace('<main id="screen" tabindex="0" aria-label="Windows 远程桌面"></main>','<main id="screen" tabindex="0" aria-label="测试显示器"><p style="padding:30px;color:white">此页面只有隔离测试数据，不连接用户虚拟机。</p></main>');
   if(asset==='desktop-session.mjs'||asset==='computer-client.mjs')body=body.toString().replaceAll('__Host-teamaibox-csrf=','monitor-fixture=');
   res.writeHead(200,{'content-type':asset.endsWith('.html')?'text/html; charset=utf-8':asset.endsWith('.css')?'text/css':'text/javascript','cache-control':'no-store','set-cookie':'monitor-fixture=disposable; Path=/'});res.end(body);
  }catch(e){json({error:{code:e.code??'fixture_error',message:e.message}},e.status??500);}
 });server.on('upgrade',(req,socket,head)=>api.attachUpgrade(req,socket,head,{context:context(user),authenticate:async()=>context(user)}).catch(()=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')));
 server.listen(port,'127.0.0.1',()=>console.log(`Disposable ${user===owner?'owner':'member'} workflow: http://127.0.0.1:${port}/`));
}
