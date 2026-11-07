import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createPenpotCredentialTransport,startPenpotCredentialTransport} from '../src/penpot-credential-transport.mjs';

async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function close(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
test('optional transport bind failure is reported once and leaves an existing listener untouched',async()=>{
  const existing=http.createServer((_req,res)=>res.end('existing-service'));
  const base=await listen(existing),diagnostics=[];
  try{
    const transport=await startPenpotCredentialTransport({port:existing.address().port,onUnavailable:code=>diagnostics.push(code)});
    assert.equal(transport,null);assert.deepEqual(diagnostics,['penpot_transport_unavailable']);
    assert.equal(await(await fetch(base)).text(),'existing-service');
  }finally{await close(existing);}
});
test('forwards unchanged native frames with only owned credential and no arbitrary targets or browser requests',async()=>{
  const secret=randomBytes(32).toString('base64url'),calls=[];
  const official=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    calls.push({path:req.url,method:req.method,headers:req.headers,body:text});
    res.writeHead(200,{'content-type':'application/json','mcp-session-id':'fixture-session','set-cookie':'must-not-leak=yes'});
    res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}));
  });
  const endpoint=await listen(official)+'/mcp';
  let enabled=true;
  const transport=createPenpotCredentialTransport({load:async()=>{if(!enabled)throw Error('disabled');return {endpoint,credential:secret};}});
  const base=await listen(transport);
  try{
    const frame=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}});
    const result=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer client-spoof',
      'mcp-protocol-version':'2025-03-26','x-teamaibox-user-token':'spoof'},body:frame});
    assert.equal(result.status,200);assert.equal(result.headers.get('mcp-session-id'),'fixture-session');
    assert.equal(result.headers.has('set-cookie'),false);assert.equal((await result.text()).includes(secret),false);
    assert.equal(calls.length,1);assert.equal(calls[0].body,frame);assert.equal(calls[0].headers.authorization,'Bearer '+secret);
    assert.equal(calls[0].headers['x-teamaibox-user-token'],undefined);
    for(const path of ['/mcp?userToken=spoof','/mcp/','/sse','/healthz'])assert.equal((await fetch(base+path)).status,403);
    for(const headers of [{origin:'https://example.invalid'},{cookie:'platform=secret'}])assert.equal((await fetch(base+'/mcp',{headers})).status,403);
    assert.equal(calls.length,1);
    enabled=false;assert.equal((await fetch(base+'/mcp')).status,503);assert.equal(calls.length,1);
  }finally{await close(transport);await close(official);}
});
test('redirects are not followed, failures are redacted and request bodies are never replayed',async()=>{
  let calls=0;
  const transport=createPenpotCredentialTransport({load:async()=>({endpoint:'http://example.invalid/mcp',credential:'private-value'}),
    fetchImpl:async()=>{calls++;return new Response('private upstream failure',{status:302,headers:{location:'https://other.invalid/'}});}});
  const base=await listen(transport);
  try{const r=await fetch(base+'/mcp',{method:'POST',body:'opaque-json-rpc'});assert.equal(r.status,503);assert.equal(calls,1);
    assert.equal(await r.text(),'{"error":"Design transport unavailable"}');}
  finally{await close(transport);}
});
test('disabling the owned context closes an existing stream without reconnecting',async()=>{
  let enabled=true,calls=0;
  const transport=createPenpotCredentialTransport({load:async()=>{if(!enabled)throw Error('disabled');return {endpoint:'http://example.invalid/mcp',credential:'private-value'};},
    fetchImpl:async(_url,options)=>{calls++;return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
      options.signal.addEventListener('abort',()=>controller.error(Error('revoked')),{once:true});
    }}),{headers:{'content-type':'text/event-stream'}});}});
  const base=await listen(transport);
  try{const result=await fetch(base+'/mcp');const reader=result.body.getReader();await reader.read();enabled=false;
    const start=Date.now();await assert.rejects(reader.read());assert.ok(Date.now()-start<5000);assert.equal(calls,1);}
  finally{await close(transport);}
});
