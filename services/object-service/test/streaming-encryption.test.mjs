import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {FilesystemBlobStore} from '../src/filesystem-blob-store.mjs';
import {EnvelopeEncryptedBlobStore} from '../src/envelope-encrypted-blob-store.mjs';
import {MemoryEnvelopeMetadataRepository} from '../src/envelope-metadata-repository.mjs';
import {MemoryVersionedEnvelopeKeyring} from '../src/envelope-keyring.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'teamaibox-stream-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const rawStore=new FilesystemBlobStore({root});
  rawStore.get=()=>assert.fail('streaming must not read the whole file');
  const keyring=new MemoryVersionedEnvelopeKeyring(Buffer.alloc(32,17));t.after(()=>keyring.close());
  const repository=new MemoryEnvelopeMetadataRepository();
  return {root,rawStore,repository,store:new EnvelopeEncryptedBlobStore({rawStore,keyring,metadataRepository:repository})};
}
test('80 MiB encrypted object round trips as bounded chunks, with no whole-file read',async t=>{
  const {store}=await fixture(t),key='objects/'+randomUUID();
  const chunk=Buffer.alloc(1024**2,123),count=80,hash=createHash('sha256');
  for(let i=0;i<count;i++)hash.update(chunk);
  const digest=hash.digest('hex'),borrowed=[];
  await store.putStream(key,(async function*(){for(let i=0;i<count;i++)yield chunk;})(),
    {plaintextSize:count*chunk.length,plaintextSha256:digest});
  const received=createHash('sha256');let size=0;
  for await(const bytes of await store.read(key)){
    assert.ok(bytes.length<=1024**2);size+=bytes.length;received.update(bytes);borrowed.push(bytes);
  }
  assert.equal(size,80*1024**2);assert.equal(received.digest('hex'),digest);
  assert.ok(borrowed.every(bytes=>bytes.every(byte=>byte===0)));
  assert.equal((await store.metadata(key)).schemaVersion,1);
});
test('wrong stream digest and interrupted input leave neither metadata nor temporary file',async t=>{
  const {root,store,repository}=await fixture(t),bytes=Buffer.from('test payload');
  for(const mode of ['checksum','interrupted']){
    const key='objects/'+randomUUID();
    await assert.rejects(store.putStream(key,(async function*(){yield bytes;if(mode==='interrupted')throw Error('interrupted');})(),
      {plaintextSize:bytes.length,plaintextSha256:'0'.repeat(64)}));
    assert.equal(await repository.load(key),null);assert.equal(await store.has(key),false);
  }
  assert.deepEqual(await readdir(join(root,'objects')),[]);
});
test('consumer cancellation releases the encrypted read stream',async t=>{
  const {store}=await fixture(t),key='objects/'+randomUUID(),bytes=Buffer.alloc(2*1024**2,11);
  await store.putStream(key,(async function*(){yield bytes;})(),{plaintextSize:bytes.length,plaintextSha256:createHash('sha256').update(bytes).digest('hex')});
  let borrowed;for await(const chunk of await store.read(key)){borrowed=chunk;break;}
  assert.ok(borrowed.every(b=>b===0));
  assert.equal(await store.delete(key),true);
});
