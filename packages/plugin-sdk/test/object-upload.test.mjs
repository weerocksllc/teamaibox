import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {uploadObject} from '../src/object-upload.mjs';
import {sha256Blob} from '../src/sha256.mjs';

const id='b201e0a6-f6bf-4c3c-bf7e-76a372781236';
const digest=b=>createHash('sha256').update(b).digest('hex');
const response=(value,status=200)=>new Response(JSON.stringify(value),{status});
test('shared uploader hashes incrementally and uses server-selected parts for every application',async()=>{
  for(const capability of ['ocr','asr','image','translation','messaging.attachment']){
    const file=new File([Buffer.alloc(1024*1024+17,19)],'office-file');
    file.arrayBuffer=()=>{throw Error('whole file buffering forbidden');};
    const expected=digest(Buffer.alloc(file.size,19)),calls=[],parts=[];
    const result=await uploadObject(file,{capability,csrf:'csrf-test',fetchImpl:async(path,request)=>{
      calls.push(path);assert.equal(request.credentials,'same-origin');assert.equal(request.headers['x-csrf-token'],'csrf-test');
      if(path.endsWith('/multipart')){const value=JSON.parse(request.body);assert.equal(value.capability,capability);assert.equal(value.sha256,expected);return response({upload:{uploadId:id},part_size_bytes:512*1024});}
      if(path.includes('/parts/')){assert.ok(request.body.size<=512*1024);const raw=Buffer.from(await request.body.arrayBuffer());assert.equal(request.headers['x-content-sha256'],digest(raw));parts.push(raw);return response({});}
      assert.equal(JSON.parse(request.body).parts.length,3);
      return response({object:{size:file.size,integrity:{digest:expected}},reference_id:id});
    }});
    assert.equal(result.reference_id,id);assert.equal(digest(Buffer.concat(parts)),expected);assert.equal(calls.length,5);
  }
});
test('failed or cancelled upload aborts only its multipart object',async()=>{
  const controller=new AbortController(),methods=[];
  await assert.rejects(uploadObject(new File(['hello'],'file'),{capability:'ocr',csrf:'x',signal:controller.signal,
    fetchImpl:async(path,request)=>{methods.push(request.method);if(path.endsWith('/multipart'))return response({upload:{uploadId:id},part_size_bytes:2});
      if(request.method==='DELETE'){assert.equal(path,'/api/v1/objects/multipart/'+id);assert.equal(request.signal.aborted,false);return response({});}
      controller.abort();throw Error('cancelled');}}));
  assert.deepEqual(methods,['POST','PUT','DELETE']);
});
test('incremental hash matches SHA256 across padding boundaries',async()=>{
  for(const size of [0,1,55,56,63,64,65,127,129,100_001]){const bytes=Buffer.alloc(size,51);assert.equal(await sha256Blob(new Blob([bytes]),{chunkBytes:67}),digest(bytes));}
});
