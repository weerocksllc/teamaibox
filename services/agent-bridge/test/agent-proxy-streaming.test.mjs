import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createRotatingModelCredentialProxy} from '../src/rotating-model-credential-proxy.mjs';
import {createAgentBridgeRouteProxy} from '../src/agent-bridge-route-proxy.mjs';

async function listen(server,t){
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  return 'http://127.0.0.1:'+server.address().port;
}
for(const kind of ['bridge','model'])test(`${kind} streams a chunked request above the old byte cap before the upload ends`,async t=>{
  let firstByte;const sawFirstByte=new Promise(resolve=>{firstByte=resolve;});
  const token='a'.repeat(48),source=Buffer.alloc(5*1024**2+73,0x61);
  const expected=createHash('sha256').update(source).digest('hex');
  const destination=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+token);
    const hash=createHash('sha256');let total=0;
    for await(const chunk of req){total+=chunk.length;hash.update(chunk);firstByte();}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({total,sha256:hash.digest('hex')}));
  });
  const upstreamOrigin=await listen(destination,t);
  const proxy=kind==='bridge'?createAgentBridgeRouteProxy({upstreamOrigin})
    :createRotatingModelCredentialProxy({upstreamOrigin,credentialProvider:async()=>token});
  const origin=await listen(proxy,t),path=kind==='bridge'?'/v1/sessions':'/v1/chat/completions';
  async function* chunks(){
    yield source.subarray(0,65536);
    // Deadlocks if the proxy waits for the entire request instead of streaming.
    let timer;try{await Promise.race([sawFirstByte,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('proxy_buffered_request')),3000);})]);}
    finally{clearTimeout(timer);}
    for(let offset=65536;offset<source.length;offset+=65536)yield source.subarray(offset,offset+65536);
  }
  const response=await fetch(origin+path,{method:'POST',body:chunks(),duplex:'half',headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{total:source.length,sha256:expected});
});
