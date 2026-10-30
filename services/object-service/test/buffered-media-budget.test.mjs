import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {gzipSync,brotliCompressSync,deflateSync} from 'node:zlib';
import {bufferedMediaBytes,reserveBufferedMedia,bufferedMediaResponse,createBufferedMediaAccount,cgroupMediaHeadroom} from '../src/buffered-media-budget.mjs';

test('ISO upload headroom includes only reclaimable inactive file cache',()=>{
  assert.equal(cgroupMediaHeadroom(2048,1840,'inactive_file 1376\nfile_dirty 0\nfile_writeback 0\nshmem 0'),1584);
  assert.equal(cgroupMediaHeadroom(2048,1840,'inactive_file 1376\nfile_dirty 400\nfile_writeback 200\nshmem 100'),884);
  assert.equal(cgroupMediaHeadroom(2048,1840,'anon 1700\nactive_file 140'),208);
  assert.equal(cgroupMediaHeadroom(2048,1840,'inactive_file 100\nfile_dirty 200'),208);
  assert.equal(cgroupMediaHeadroom(2048,1840,''),208);
  assert.equal(cgroupMediaHeadroom(2048,2048,'inactive_file invalid'),0);
  assert.equal(cgroupMediaHeadroom(2048,1840,'inactive_file 9000'),2048);
});

test('control messages are independent of file reservations but still obey live memory',async()=>{
  let available=1024;
  const media={available:()=>available,heap:()=>1024,copies:8,account:createBufferedMediaAccount()};
  const control={...media,account:createBufferedMediaAccount()};
  const release=reserveBufferedMedia(100,media);
  try{
    available=256;
    assert.equal(bufferedMediaBytes(media),0);
    assert.equal((await bufferedMediaResponse(new Response('heartbeat'),control)).toString(),'heartbeat');
    available=8;
    await assert.rejects(bufferedMediaResponse(new Response('heartbeat'),control),{code:'media_memory_unavailable'});
  }finally{release();}
});

test('declared-body rejection cancels unread responses before acquiring an iterator',async()=>{
  let cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  const options={available:()=>100,heap:()=>100,copies:8,account:createBufferedMediaAccount()};
  await assert.rejects(bufferedMediaResponse(new Response(body,{headers:{'content-length':'100'}}),options),{code:'media_memory_unavailable'});
  assert.equal(cancelled,true);assert.equal(bufferedMediaBytes(options),12);
});

test('processing admission follows available memory, not a 32/64 MB file quota',()=>{
  let available=512*1024**2;
  const options={available:()=>available,heap:()=>1024**3,copies:4};
  assert.ok(bufferedMediaBytes(options)>64*1024**2);
  const release=reserveBufferedMedia(80*1024**2,options);
  assert.throws(()=>reserveBufferedMedia(80*1024**2,options),{code:'media_memory_unavailable'});
  release();release();assert.ok(bufferedMediaBytes(options)>64*1024**2);
  available=16*1024**2;
  assert.throws(()=>reserveBufferedMedia(8*1024**2,options),{code:'media_memory_unavailable'});
  assert.throws(()=>reserveBufferedMedia(Number.MAX_SAFE_INTEGER+1,options),{code:'invalid_object_content'});
});

test('unknown-length responses cannot bypass memory admission, and cancellation releases it',async()=>{
  const options={available:()=>512,heap:()=>512,copies:4};
  let cancelled=false;
  const response=new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(80));},cancel(){cancelled=true;}}));
  await assert.rejects(bufferedMediaResponse(response,options),{code:'media_memory_unavailable'});
  assert.equal(cancelled,true);assert.equal(bufferedMediaBytes(options),128);
  const accepted=await bufferedMediaResponse(new Response('hello'),options);
  assert.equal(accepted.toString(),'hello');assert.equal(bufferedMediaBytes(options),128);
});

for(const [encoding,compress] of [['gzip',gzipSync],['br',brotliCompressSync],['deflate',deflateSync]])
test(`fetch ${encoding} decoded length is independent of wire length, but still memory admitted`,async t=>{
  const text='办公文档'.repeat(2000),raw=Buffer.from(text),packed=compress(raw);
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-encoding':encoding,'content-length':packed.length});res.end(packed);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const url='http://127.0.0.1:'+server.address().port;
  const options={available:()=>1024**2,heap:()=>1024**2,copies:4};
  assert.equal((await bufferedMediaResponse(await fetch(url),options)).toString(),text);
  await assert.rejects(bufferedMediaResponse(await fetch(url),{available:()=>4096,heap:()=>4096,copies:4}),{code:'media_memory_unavailable'});
});

test('identity responses still reject an inconsistent declared length',async()=>{
  await assert.rejects(bufferedMediaResponse(new Response('abc',{headers:{'content-length':'4'}})),{code:'media_response_invalid'});
});
