import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
const endpoint=process.env.PLATFORM_OBJECT_SERVICE_ENDPOINT;
assert.equal(new URL(endpoint).hostname,'object-service');
const token=(await readFile(process.env.PLATFORM_OBJECT_SERVICE_TOKEN_FILE,'utf8')).trim();
const tail=Buffer.from('{"method":"validation.nonexistent","input":{}}');
const chunk=Buffer.alloc(1024**2,32);
const bytes=97*chunk.length+tail.length;
async function* body(){for(let i=0;i<97;i++)yield chunk;yield tail;}
const response=await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
  body:Readable.toWeb(Readable.from(body())),duplex:'half',signal:AbortSignal.timeout(60000)});
const value=await response.json();
assert.equal(response.status,403);assert.equal(value.error.code,'object_rpc_method_denied');
// A deliberate invalid method proves the complete >96 MiB JSON reached method
// dispatch without creating an object or bypassing authorization.
console.log(JSON.stringify({status:'passed',bytes,httpStatus:response.status,result:value.error.code,
  methodExecuted:false,objectsCreated:false,scope:'transport-admission-only'}));
