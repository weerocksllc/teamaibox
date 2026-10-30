// Run with docker exec inside the API container. Read numeric diagnostics only;
// do not collect a heap snapshot, guest data, environment or credentials.
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const candidates=[];
for(const name of await readdir('/proc')){
  if(!/^\d+$/.test(name)||Number(name)===process.pid)continue;
  try{const args=(await readFile(`/proc/${name}/cmdline`,'utf8')).split('\0');
    if(args[0]?.split('/').at(-1)==='node'&&args.some(v=>/^\/opt\/teamaibox\/apps\/platform-api\/server\/(platform-api|managed-node-production-main)\.mjs$/.test(v)))candidates.push(Number(name));
  }catch{}
}
if(candidates.length!==1)throw Error('exact_platform_process_required');
async function endpoint(){try{return (await (await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(1000)})).json())[0]?.webSocketDebuggerUrl;}catch{return null;}}
let url=await endpoint(),opened=false,ws,evaluate;
try{
  if(!url){process.kill(candidates[0],'SIGUSR1');opened=true;for(let n=0;n<30&&!url;n++){await delay(100);url=await endpoint();}}
  if(!url)throw Error('local_inspector_unavailable');
  ws=new WebSocket(url);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});
  let next=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}};
  evaluate=async function(expression){const id=++next;const result=new Promise(resolve=>pending.set(id,resolve));ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));const r=await Promise.race([result,delay(10000).then(()=>{throw Error('inspection_timeout');})]);if(r.error||r.result.exceptionDetails)throw Error('inspection_failed');return r.result.result.value;};
  const result=await evaluate(`(()=>{const b=process.getBuiltinModule('node:module').createRequire('/opt/teamaibox/package.json')('/opt/teamaibox/services/object-service/src/buffered-media-budget.mjs');return {memory:process.memoryUsage(),heap:process.getBuiltinModule('node:v8').getHeapStatistics(),bodyBudget:b.bufferedMediaBytes(),reservationLowerBound:400000000-b.bufferedMediaBytes({available:()=>400000000,heap:()=>400000000,copies:1}),available:b.availableMediaMemory(),resources:process.getActiveResourcesInfo().reduce((a,k)=>(a[k]=(a[k]||0)+1,a),{}),uptimeSeconds:process.uptime()};})()`);
  console.log(JSON.stringify(result));
}finally{
  if(evaluate&&(opened||process.env.CLOSE_OWNED_INSPECTOR==='1'))await evaluate(`(setTimeout(()=>process.getBuiltinModule('node:inspector').close(),100),true)`).catch(()=>{});
  ws?.close();
}
