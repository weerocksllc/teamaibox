import assert from "node:assert/strict";
import { test } from "node:test";

import { drawingIntentCatalogV2 } from "../src/applications/drawing-intent-router-v2.mjs";

const MAIN = "drawing.flux2-klein-4b.bf16.main-protected.v2";
const AUX_FLUX = "drawing.flux2-klein-4b.nvfp4.spark23.provider.v1";
const LONGCAT = "drawing.longcat-image.bf16.spark23.resource.20260916";

function compute(overrides = {}) {
  return { certifiedProfiles: [], experimentalProfiles: [MAIN, AUX_FLUX, LONGCAT],
    localRoutableProfiles: [MAIN], providerRoutableProfiles: [AUX_FLUX, LONGCAT],
    localActuallyRoutableProfiles: [MAIN],
    providerActuallyRoutableProfiles: [AUX_FLUX, LONGCAT], ...overrides };
}

test("a deployed successor replaces the ordinary profile without stale UI disclosure", () => {
  const ordinaryProfile = { profileId: "33333333-3333-4333-8333-333333333333",
    profileKey: "drawing.flux2-klein-4b.bf16.main-protected.successor" };
  const state = compute({ localActuallyRoutableProfiles: [ordinaryProfile.profileKey],
    experimentalProfiles: [ordinaryProfile.profileKey] });
  const result = drawingIntentCatalogV2(state, { ordinaryProfile });
  assert.equal(result.intents.every((v) => v.available && v.selectedProfileId === ordinaryProfile.profileId
    && v.selectedProfile === ordinaryProfile.profileKey), true);
  assert.equal(drawingIntentCatalogV2(compute(), { ordinaryProfile }).intents.every((v) => !v.available), true);
});

test("pins both ordinary aliases to the one protected main-box FLUX profile without fallback", () => {
  const value = drawingIntentCatalogV2(compute());
  assert.equal(value.schema, "teamaibox.drawing-intents.v2");
  assert.equal(value.policyVersion, "protected-main-default.v1");
  assert.equal(value.ordinaryPolicy.fallbackAllowed, false);
  assert.equal(value.ordinaryPolicy.selectedProfile, MAIN);
  assert.equal(value.ordinaryPolicy.selectedProfileId, "06c9542e-4bf3-5f4f-a41e-c7768398e2ea");
  assert.deepEqual(value.intents.map((intent) => intent.intentKey), ["automatic", "fast"]);
  for (const intent of value.intents) {
    assert.equal(intent.available, true);
    assert.equal(intent.selectedProfile, MAIN);
    assert.equal(intent.route, "local");
    assert.equal(intent.processingLocation, "appliance");
    assert.equal(intent.placementClass, "protected-resident");
    assert.equal(intent.nodeRole, "main-box");
    assert.equal(intent.exclusive, false);
    assert.equal(intent.constraints.maximumWidth, 512);
    assert.equal(intent.constraints.maximumHeight, 512);
  }
});

test("fails ordinary routing closed when only auxiliary drawing families are healthy", () => {
  const value = drawingIntentCatalogV2(compute({ localActuallyRoutableProfiles: [],
    providerActuallyRoutableProfiles: [AUX_FLUX, LONGCAT] }));
  assert.equal(value.ordinaryPolicy.selectedProfile, null);
  assert.equal(value.intents.every((intent) => intent.available === false), true);
  assert.equal(value.intents.every((intent) => intent.reasonCode === "protected_office_profile_unavailable"), true);
  assert.equal(JSON.stringify(value.intents).includes(AUX_FLUX), false);
  assert.equal(JSON.stringify(value.intents).includes(LONGCAT), false);
});

test("requires explicit eligible per-profile local routability for the protected default", () => {
  const broadOnly = drawingIntentCatalogV2(compute({ localActuallyRoutableProfiles: undefined, localRoute: true }));
  assert.equal(broadOnly.intents.every((intent) => intent.available === false), true);
  const notEligible = drawingIntentCatalogV2(compute({ experimentalProfiles: [AUX_FLUX, LONGCAT] }));
  assert.equal(notEligible.intents.every((intent) => intent.available === false), true);
});

test("only the local drawing capabilities are published, including for administrators", () => {
  const value=drawingIntentCatalogV2(compute(),{advancedAuthorized:true});
  assert.equal(Object.hasOwn(value,"advancedControls"),false);
  assert.equal(JSON.stringify(value).includes(AUX_FLUX),false);
  assert.equal(JSON.stringify(value).includes(LONGCAT),false);
  assert.equal(value.externalProcessingDisclosureRequired,false);
});
