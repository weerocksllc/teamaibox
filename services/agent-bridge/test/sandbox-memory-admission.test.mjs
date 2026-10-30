import test from 'node:test';
import assert from 'node:assert/strict';
import {sandboxMemoryAdmission as plan} from '../src/sandbox-memory-admission.mjs';
const G=1024**3;
test('37 GiB available admits an 8 GiB sandbox and retains 16 GiB margin',()=>{
 const p=plan({availableBytes:37*G,requestedBytes:8*G});
 assert.equal(p.eligible,true);assert.equal(p.remainingBytes,29*G);
});
test('running resident usage is not double charged',()=>{
 const p=plan({availableBytes:32*G,requestedBytes:8*G,running:[{limitBytes:8*G,usageBytes:8*G,reclaimableBytes:0}]});
 assert.equal(p.eligible,true);assert.equal(p.unrealizedBytes,0);
});
test('unconsumed reservations remain charged',()=>{
 const p=plan({availableBytes:30*G,requestedBytes:8*G,running:[{limitBytes:8*G,usageBytes:G,reclaimableBytes:0}]});
 assert.equal(p.eligible,false);assert.equal(p.unrealizedBytes,7*G);
});
test('reclaimable cache cannot count as already consumed',()=>{
 const p=plan({availableBytes:31*G,requestedBytes:8*G,running:[{limitBytes:8*G,usageBytes:8*G,reclaimableBytes:7*G}]});
 assert.equal(p.unrealizedBytes,7*G);assert.equal(p.remainingBytes,16*G);
});
test('margin boundary and explicit policy are enforced',()=>{
 assert.equal(plan({availableBytes:24*G-1,requestedBytes:8*G}).eligible,false);
 assert.equal(plan({availableBytes:24*G,requestedBytes:8*G}).eligible,true);
 assert.equal(plan({availableBytes:37*G,requestedBytes:8*G,marginBytes:32*G}).eligible,false);
});
test('missing or invalid telemetry fails closed',()=>{
 for(const change of [{availableBytes:NaN},{requestedBytes:0},{running:[{limitBytes:8*G,usageBytes:0}]},
   {running:[{limitBytes:8*G,usageBytes:G,reclaimableBytes:2*G}]}])
  assert.throws(()=>plan({availableBytes:37*G,requestedBytes:8*G,...change}),/telemetry/);
});
