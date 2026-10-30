import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readObjectRpcBody } from '../src/internal-rpc-server.mjs';
import { reserveBufferedMedia } from '../src/buffered-media-budget.mjs';

test('RPC accepts an actual body above 96 MiB when memory is available', async () => {
  const block = Buffer.alloc(1024**2, 32);
  async function* input() {
    for (let i=0;i<97;i++) yield block;
    yield Buffer.from('{}');
  }
  let held=0;
  const result = await readObjectRpcBody(input(), bytes => {
    const release=reserveBufferedMedia(bytes,{available:()=>8*1024**3,heap:()=>8*1024**3});
    held+=bytes;
    return ()=>{held-=bytes;release();};
  });
  assert.deepEqual(result.value,{});
  assert.equal(held,97*1024**2+2);
  assert.equal(block[0],32,'caller bytes were not wiped');
  result.release();result.release();assert.equal(held,0);
});

test('RPC releases earlier reservations on memory denial and parse failure', async () => {
  for (const failure of ['memory','json','transport']) {
    let held=0,calls=0;
    async function* input(){yield Buffer.from('{');if(failure==='transport')throw Error('transport');yield Buffer.from('x');}
    await assert.rejects(readObjectRpcBody(input(),bytes=>{
      if(failure==='memory'&&++calls===2) return reserveBufferedMedia(bytes,{available:()=>0,heap:()=>0});
      held+=bytes;return()=>{held-=bytes;};
    }));
    assert.equal(held,0,failure);
  }
});
