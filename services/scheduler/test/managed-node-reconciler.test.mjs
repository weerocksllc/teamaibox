import assert from "node:assert/strict";
import test from "node:test";

import { ManagedNodeReconciler } from "../src/managed-node-reconciler.mjs";

test("managed node reconciliation never overlaps and contains transient failures", async () => {
  let release, calls = 0, errors = 0;
  const service = { async reconcileStale() { calls += 1; if (calls === 1) await new Promise((resolve) => { release = resolve; }); else throw new Error("database unavailable"); return { fenced: [] }; } };
  const reconciler = new ManagedNodeReconciler({ service, onError() { errors += 1; } });
  const first = reconciler.reconcileNow(), replay = reconciler.reconcileNow();
  assert.equal(calls, 1); release(); assert.equal(await first, await replay);
  assert.deepEqual(await reconciler.reconcileNow(), { fenced: [] }); assert.equal(errors, 1);
  reconciler.start(); reconciler.stop();
});

test("controller pause reopens a fresh-heartbeat gate before stale fencing", async () => {
  let now=0;const events=[];
  const service={async reconcileStale(){events.push('sweep');return {fenced:[]};},
    async beginObservationWindow(options){assert.deepEqual(options,{restartObservation:true});events.push('fresh-heartbeat-gate');}};
  const r=new ManagedNodeReconciler({service,clock:()=>now});
  await r.reconcileNow();now=15_000;await r.reconcileNow();now=50_000;await r.reconcileNow();
  now=65_000;await r.reconcileNow();
  assert.deepEqual(events,['sweep','sweep','fresh-heartbeat-gate','sweep','sweep']);
});

test("failed resume quarantine is retried without running a stale sweep", async () => {
  let now=0,resets=0,sweeps=0,errors=0;
  const service={async reconcileStale(){sweeps++;return {fenced:[]};},
    async beginObservationWindow(){resets++;if(resets===1)throw Error('database unavailable');}};
  const r=new ManagedNodeReconciler({service,clock:()=>now,onError(){errors++;}});
  await r.reconcileNow();now=35_000;await r.reconcileNow();assert.equal(sweeps,1);
  now=50_000;await r.reconcileNow();assert.equal(resets,2);assert.equal(sweeps,2);assert.equal(errors,1);
});

test("ordinary observation cadence does not keep extending node timeout", async () => {
  let now=0,resets=0,sweeps=0;
  const r=new ManagedNodeReconciler({service:{async reconcileStale(){sweeps++;return {fenced:[]};},
    async beginObservationWindow(){resets++;}},clock:()=>now});
  for(let i=0;i<8;i++){now=i*15_000;await r.reconcileNow();}
  assert.equal(sweeps,8);assert.equal(resets,0);
});
