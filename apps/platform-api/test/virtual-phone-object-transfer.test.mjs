import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import {PhoneObjectTransfer,phoneTransferInput,phoneTransferName} from '../src/virtual-phones/phone-object-transfer.mjs';
import {MemoryBlobStore} from '../../../services/object-service/src/memory-blob-store.mjs';
import {MemoryObjectRepository} from '../../../services/object-service/src/memory-repository.mjs';
import {ProtectedObjectService} from '../../../services/object-service/src/object-service.mjs';
import {EnvelopeEncryptedBlobStore} from '../../../services/object-service/src/envelope-encrypted-blob-store.mjs';
import {MemoryEnvelopeMetadataRepository} from '../../../services/object-service/src/envelope-metadata-repository.mjs';
import {MemoryVersionedEnvelopeKeyring} from '../../../services/object-service/src/envelope-keyring.mjs';
import {createObjectRpcServer} from '../../../services/object-service/src/internal-rpc-server.mjs';
import {RemoteProtectedObjectService} from '../../../services/object-service/src/internal-rpc-client.mjs';
import {ArtifactProvenanceService} from '../../../services/object-service/src/artifact-provenance-service.mjs';
import {MemoryArtifactProvenanceRepository} from '../../../services/object-service/src/memory-artifact-provenance-repository.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const ownerId=randomUUID(),phoneId=randomUUID(),namespaceKey=`user:${ownerId}`,rawStore=new MemoryBlobStore();
  const keyring=new MemoryVersionedEnvelopeKeyring(Buffer.alloc(32,37));t.after(()=>keyring.close());
  const blobs=new EnvelopeEncryptedBlobStore({rawStore,keyring,metadataRepository:new MemoryEnvelopeMetadataRepository()});
  const objects=new ProtectedObjectService({repository:new MemoryObjectRepository({defaultQuotaBytes:32*1024**2}),blobStore:blobs,referenceSigningKey:Buffer.alloc(32,23)});
  const context={identityId:ownerId,identityKind:'local_user',namespaceAccess:[{namespaceKey,operations:['read','write','list','delete','reference:create']}]};
  return {ownerId,phoneId,objects,context,namespaceKey,rawStore,blobs,transfer:new PhoneObjectTransfer({objectService:objects}),
    async input(content){const object=await objects.upload({context,namespaceKey,objectKey:'phone-test/input.apk',contentType:'application/octet-stream',content,expectedSha256:hash(content)});
      return {objectId:object.objectId,objectVersion:object.version,name:'应用.apk',sizeBytes:content.length,sha256:hash(content)};}};
}
async function* pieces(content){for(let offset=0;offset<content.length;offset+=65536)yield content.subarray(offset,offset+65536);}

test('object RPC transfers phone files as an authorized stream without whole-file JSON',async t=>{
  const f=fixture(t),token=Buffer.alloc(32,47).toString('base64url');
  const provenanceService=new ArtifactProvenanceService({repository:new MemoryArtifactProvenanceRepository(),objectGateway:f.objects.createObjectHandoffGateway()});
  const server=createObjectRpcServer({token,objectService:f.objects,provenanceService});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const requests=[];
  const client=new RemoteProtectedObjectService({endpoint:'http://object-service:8080/internal/v1/call',token,
    fetchImplementation:(_url,options)=>{const r=JSON.parse(options.body);requests.push({method:r.method,range:r.input?.range});
      return fetch(`http://127.0.0.1:${server.address().port}/internal/v1/call`,options);}});
  assert.equal(typeof client.head,'function');
  const transfer=new PhoneObjectTransfer({objectService:client}),content=Buffer.from('real encrypted RPC phone test'),input=await f.input(content);
  const received=await transfer.withInput({ownerId:f.ownerId,input},async({chunks})=>{const out=[];for await(const c of chunks)out.push(Buffer.from(c));return Buffer.concat(out);});
  assert.deepEqual(received,content);
  assert.deepEqual(requests.map(r=>r.method),['head','downloadStream']);
  const count=requests.length;
  await assert.rejects(transfer.withInput({ownerId:f.ownerId,input:{...input,sizeBytes:content.length+1}},()=>assert.fail()),{code:'phone_object_invalid'});
  assert.equal(requests.length,count+1,'bad metadata must not trigger a full download');
  await assert.rejects(transfer.withInput({ownerId:randomUUID(),input},()=>assert.fail()),{code:'phone_object_invalid'});
});

test('phone transfers reuse real AES-GCM objects, exact versions and owner isolation, with no plaintext staging',async t=>{
  const f=fixture(t),original=Buffer.from('synthetic phone file '.repeat(4096)),input=await f.input(original),borrowed=[];
  const received=await f.transfer.withInput({ownerId:f.ownerId,input},async({metadata,chunks})=>{
    assert.deepEqual(metadata,input);const copies=[];
    for await(const chunk of chunks){assert.ok(chunk.length<=65536);borrowed.push(chunk);copies.push(Buffer.from(chunk));}
    return Buffer.concat(copies);
  });
  assert.deepEqual(received,original);assert.ok(borrowed.every(bytes=>bytes.every(byte=>byte===0)),'input plaintext released');
  await assert.rejects(f.transfer.withInput({ownerId:randomUUID(),input},()=>assert.fail('foreign data consumed')),{code:'phone_object_invalid'});
  await assert.rejects(f.transfer.withInput({ownerId:f.ownerId,input:{...input,sha256:'0'.repeat(64)}},()=>assert.fail('wrong hash consumed')),{code:'phone_object_invalid'});
  const object=await f.transfer.storeOutput({ownerId:f.ownerId,phoneId:f.phoneId,name:'会议记录.txt',sizeBytes:original.length,sha256:hash(original),chunks:pieces(original)});
  assert.equal(object.namespaceKey,f.namespaceKey);assert.match(object.objectKey,new RegExp(`^virtual-phones/${f.phoneId}/exports/`));
  assert.deepEqual((await f.objects.download({context:f.context,namespaceKey:f.namespaceKey,objectId:object.objectId,version:object.version})).content,original);
  for(const {blobKey} of await f.rawStore.list()){
    assert.equal((await f.rawStore.get(blobKey)).indexOf(original.subarray(0,1024)),-1,'raw store has ciphertext, not the phone file');
    assert.equal((await f.blobs.metadata(blobKey)).dataEncryption.algorithm,'aes-256-gcm');
  }
});

test('size, malformed names, paths, foreign namespaces and metadata are rejected before opening content',async t=>{
  const f=fixture(t),input=await f.input(Buffer.from('test'));
  for(const name of ['../secret','dir/file','dir\\file','..','\u0000.apk','a\u202eb.apk',' name'])assert.throws(()=>phoneTransferName(name),{code:'phone_input_invalid'});
  assert.equal(phoneTransferName('会议 (最终).txt'),'会议 (最终).txt');
  assert.equal(phoneTransferInput({...input,sizeBytes:512*1024**2}).sizeBytes,512*1024**2);
  assert.throws(()=>phoneTransferInput({...input,sizeBytes:512*1024**2},256*1024**2),{code:'phone_upload_too_large'});
  assert.throws(()=>phoneTransferInput({...input,namespaceKey:'user:another'}),{code:'phone_input_invalid'});
  let downloads=0;const original=f.objects.download.bind(f.objects);f.objects.download=async value=>{downloads++;return original(value);};
  await assert.rejects(f.transfer.withInput({ownerId:f.ownerId,input:{...input,sizeBytes:5}},()=>{}),{code:'phone_object_invalid'});
  assert.equal(downloads,0);
});

test('partial, over-limit, wrong-digest and cancelled output abort exact multipart uploads',async t=>{
  const f=fixture(t),original=Buffer.alloc(5*1024**2,137),aborted=[];
  const abort=f.objects.abortMultipart.bind(f.objects);f.objects.abortMultipart=async input=>{aborted.push(input.uploadId);return abort(input);};
  const common={ownerId:f.ownerId,phoneId:f.phoneId,name:'export.bin',sizeBytes:original.length,sha256:hash(original)};
  await assert.rejects(f.transfer.storeOutput({...common,chunks:pieces(original.subarray(0,4*1024**2))}),{code:'phone_object_invalid'});
  await assert.rejects(f.transfer.storeOutput({...common,sizeBytes:original.length-1,chunks:pieces(original)}),{code:'phone_upload_too_large'});
  await assert.rejects(f.transfer.storeOutput({...common,sha256:'0'.repeat(64),chunks:pieces(original)}),{code:'phone_object_invalid'});
  const controller=new AbortController();async function* cancelled(){yield original.subarray(0,65536);controller.abort();yield original.subarray(65536,131072);}
  await assert.rejects(f.transfer.storeOutput({...common,chunks:cancelled(),signal:controller.signal}),{name:'AbortError'});
  assert.equal(aborted.length,4);assert.equal(new Set(aborted).size,4);
  assert.deepEqual((await f.objects.list({context:f.context,namespaceKey:f.namespaceKey})).items,[]);
});

test('consumer failure wipes input, frees transfer slot, and same-owner concurrent transfer is refused',async t=>{
  const f=fixture(t),input=await f.input(Buffer.from('private bytes')),buffers=[];let entered,release;
  const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const pending=f.transfer.withInput({ownerId:f.ownerId,input},async({chunks})=>{for await(const bytes of chunks)buffers.push(bytes);entered();await gate;throw Error('peer lost');});
  await ready;await assert.rejects(f.transfer.withInput({ownerId:f.ownerId,input},()=>{}),{code:'phone_operation_conflict'});
  release();await assert.rejects(pending,/peer lost/);assert.ok(buffers.every(bytes=>bytes.every(byte=>byte===0)));
  await f.transfer.withInput({ownerId:f.ownerId,input},async({chunks})=>{for await(const bytes of chunks)assert.ok(bytes.length);});
});
