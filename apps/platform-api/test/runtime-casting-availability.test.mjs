import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeCastingAvailability } from "../src/casting/runtime-casting-availability.mjs";
import { normalizeCastingAvailabilityV1 } from "../../wireless-casting-plugin/src/public/casting-client-v1.mjs";
function setup({listening=true,signallingEnabled=true}={}) {
  let calls=0;
  const runtime={async readiness(){calls++;return {outputs:{hdmi:{available:false,reasonCode:"cast_hdmi_display_busy"},
    browser:{available:true,reasonCode:null}}};}};
  const callback={listening:()=>listening};
  return {runtime,callback,calls:()=>calls,availability:new RuntimeCastingAvailability({runtime,callback,signallingEnabled})};
}
test("live callback plus browser readiness enables browser only and satisfies the real UI contract",async()=>{
  const f=setup(), status=normalizeCastingAvailabilityV1(await f.availability.status());
  assert.equal(status.state,"ready");assert.equal(Object.hasOwn(status.outputs,"hdmi"),false);
  await f.availability.assertSessionStartAllowed({outputSinks:["browser"]});
  await assert.rejects(f.availability.assertSessionStartAllowed({outputSinks:["hdmi","browser"]}),e=>e.code==="cast_capability_unavailable");
  assert.equal("productAccepted" in status,false);
});
test("absent callback or signalling cannot be bypassed with healthy receiver config",async()=>{
  for (const options of [{listening:false},{signallingEnabled:false}]) {
    const f=setup(options), status=normalizeCastingAvailabilityV1(await f.availability.status());
    assert.equal(status.sessionStartAllowed,false);await assert.rejects(f.availability.assertSessionStartAllowed());
    if(options.listening===false)assert.equal(f.calls(),0);
  }
});
test("every status refresh checks the service; private failures are not disclosed or cached as ready",async()=>{
  const f=setup();assert.equal((await f.availability.status()).state,"ready");
  f.runtime.readiness=async()=>{throw Error("private credentials and endpoint");};
  const status=normalizeCastingAvailabilityV1(await f.availability.status());
  assert.equal(status.sessionStartAllowed,false);assert.ok(!JSON.stringify(status).includes("credentials"));
  f.callback.listening=()=>false;assert.equal((await f.availability.status()).gates[0].code,"cast_callback_unavailable");
});
