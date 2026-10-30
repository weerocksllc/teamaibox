import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {createInstallationUpload} from '../../../packages/plugin-sdk/src/installation-upload.mjs';
import {ObjectHttpApi} from '../src/objects/object-http-api.mjs';
import {ProtectedObjectService} from '../../../services/object-service/src/object-service.mjs';
import {MemoryObjectRepository} from '../../../services/object-service/src/memory-repository.mjs';
import {MemoryBlobStore} from '../../../services/object-service/src/memory-blob-store.mjs';

const ownerId='11111111-1111-4111-8111-111111111111';
function fixture() {
  const service=new ProtectedObjectService({repository:new MemoryObjectRepository(),blobStore:new MemoryBlobStore(),
    referenceSigningKey:randomBytes(32),allowTestPlaintextBlobStore:true});
  const api=new ObjectHttpApi({service}), state=new Map(), calls=[];
  const storage={getItem:k=>state.get(k)??null,setItem:(k,v)=>state.set(k,v),removeItem:k=>state.delete(k)};
  const context={identityId:ownerId,identity:{identityKind:'local_user'},permissions:['file:read','file:write','computer:use']};
  let failPart=2,loseComplete=false,tamperPart=false;
  const fetchImpl=async (path,options={})=>{
    const url=new URL(path,'https://test.invalid'),method=options.method??'GET';
    calls.push({path,method});
    if(method==='PUT'&&path.endsWith('/'+failPart)) {failPart=null;throw Error('simulated interruption');}
    const body=options.body instanceof Blob?Buffer.from(await options.body.arrayBuffer()):options.body?JSON.parse(options.body):null;
    if(method==='PUT'&&tamperPart&&Buffer.isBuffer(body)){body[0]^=1;tamperPart=false;}
    let result;
    try { result=await api.handle({method,pathname:url.pathname,query:url.searchParams,body,headers:options.headers,context}); }
    catch(e) {return {ok:false,status:e.status??400,json:async()=>({error:{code:e.code??'test_error'}})};}
    // Small transport chunks in fixtures exercise multipart without large test files.
    if(path==='/api/v1/objects/multipart') result.body.part_size_bytes=4;
    if(method==='POST'&&/multipart\/[a-f0-9-]+$/.test(path)&&loseComplete) {loseComplete=false;throw Error('lost completion response');}
    return {ok:true,status:result.status,json:async()=>result.body};
  };
  const make=()=>createInstallationUpload({ownerId,storage,fetchImpl,csrf:'fixture'});
  const file=new File(['synthetic ISO bytes'], 'test.iso');
  return {make,file,calls,storage,api,context,setLostComplete:()=>{loseComplete=true;failPart=null;},
    setTamperPart:()=>{tamperPart=true;failPart=null;}};
}

test('ISO upload resumes verified parts after interruption and file reselection',async()=>{
  const f=fixture();
  await assert.rejects(f.make().upload(f.file),/simulated interruption/);
  assert.equal(f.calls.filter(c=>c.method==='DELETE').length,0);
  await assert.rejects(f.make().upload(new File(['another ISO'], 'test.iso')),{code:'computer_upload_reselect_same_file'});
  const result=await f.make().upload(f.file);
  assert.equal(result.object.integrity.digest,createHash('sha256').update('synthetic ISO bytes').digest('hex'));
  assert.match(result.object.objectKey,/^virtual-computers\/installation\//);
  assert.equal(f.calls.filter(c=>c.method==='PUT'&&c.path.endsWith('/parts/1')).length,1);
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/api/v1/objects/multipart').length,1);
  await assert.rejects(f.api.handle({method:'GET',pathname:`/api/v1/objects/references/${result.reference_id}/content`,
    context:{...f.context,identityId:'22222222-2222-4222-8222-222222222222'}}));
});

test('lost completion reply resolves the exact committed object without another upload or completion',async()=>{
  const f=fixture();f.setLostComplete();
  await assert.rejects(f.make().upload(f.file),/lost completion/);
  const result=await f.make().upload(f.file);
  const again=await f.make().upload(f.file);
  assert.equal(result.object.objectId,again.object.objectId);
  assert.equal(f.calls.filter(c=>c.method==='POST'&&/multipart\/[a-f0-9-]+$/.test(c.path)).length,1);
  assert.equal((await f.make().cancel()).complete,true);
  f.make().acknowledgeImport();assert.equal(f.make().pending(),null);
});

test('explicit cancellation aborts only the pending ISO and clears its local journal',async()=>{
  const f=fixture();
  await assert.rejects(f.make().upload(f.file));
  const id=f.make().pending().uploadId;
  assert.deepEqual(await f.make().cancel(),{cancelled:true});
  assert.equal(f.make().pending(),null);
  assert.deepEqual(f.calls.filter(c=>c.method==='DELETE'),[{path:'/api/v1/objects/multipart/'+id,method:'DELETE'}]);
});

test('a damaged ISO part is rejected before completion and may be retransmitted from the original file',async()=>{
  const f=fixture();f.setTamperPart();
  await assert.rejects(f.make().upload(f.file));
  assert.equal(f.calls.filter(c=>c.method==='POST'&&/multipart\/[a-f0-9-]+$/.test(c.path)).length,0);
  const result=await f.make().upload(f.file);
  assert.equal(result.object.integrity.digest,createHash('sha256').update('synthetic ISO bytes').digest('hex'));
});
