import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { FileDisabledCastingAvailability } from "../src/casting/file-disabled-casting-availability.mjs";

const old = JSON.parse(await readFile(new URL("../../../deploy/casting/wireless-casting-control-plane.disabled.v1.json", import.meta.url)));
function successor() {
  return { ...structuredClone(old), schemaVersion: 2,
    configurationId: "teamaibox.wireless-casting-control-plane.disabled.v2",
    outputs: Object.fromEntries(["hdmi", "browser"].map(key => [key,
      { state: "unavailable", reasonCode: "casting_product_service_not_deployed" }])),
    gates: [
      { code: "casting_product_service_not_deployed", category: "runtime" },
      { code: "casting_office_reservation_not_integrated", category: "runtime" },
      { code: "physical_apple_sender_not_exercised", category: "hardware" },
    ],
    sourceBindings: { ...structuredClone(old.sourceBindings),
      hdmiComponent: old.sourceBindings.hardwareInventory,
      daemonComponent: old.sourceBindings.hardwareInventory },
  };
}
test("historical disabled configuration remains blocked without exposing retired display gates", () => {
  const availability = new FileDisabledCastingAvailability({ configuration: old });
  assert.equal(availability.status().gates.length, 7);
  assert.throws(() => availability.assertSessionStartAllowed(), { code: "cast_capability_unavailable" });
});
test("integration successor reports pending integration instead of obsolete hardware/legal failures", () => {
  const availability = new FileDisabledCastingAvailability({ configuration: successor() });
  assert.equal(availability.status().gates.length, 3);
  assert.equal(availability.status().receiverReady, false);
  assert.equal(availability.status().receiverAdvertisementAllowed, false);
  assert.throws(() => availability.assertSessionStartAllowed(), { code: "cast_capability_unavailable" });
});
test("successor cannot enable output, drop gates, swap categories or omit evidence bindings", () => {
  for (const change of [v => v.claims.receiverReady = true, v => v.outputs.hdmi.state = "available",
    v => v.gates.pop(), v => v.gates[0].category = "legal", v => delete v.sourceBindings.daemonComponent,
    v => v.schemaVersion = 3]) {
    const value = successor(); change(value);
    assert.throws(() => new FileDisabledCastingAvailability({ configuration: value }), TypeError);
  }
});
