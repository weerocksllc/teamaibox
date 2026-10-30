import assert from "node:assert/strict";
import { test } from "node:test";
import { drawingIntentKeysV2, parseDrawingIntentRouterV2,
  preferredDrawingIntentV2 } from "../src/public/intent-router-client-v2.mjs";

const MAIN = "drawing.flux2-klein-4b.bf16.main-protected.v2";
const MAIN_ID = "06c9542e-4bf3-5f4f-a41e-c7768398e2ea";
const available = (intentKey) => ({ intentKey, modelAlias: `drawing.${intentKey}`,
  operation: "images.generations", available: true, reasonCode: null, selectedProfile: MAIN,
  selectedProfileId: MAIN_ID, selectedProfileDisplayName: "FLUX.2 Klein 4B Distilled BF16",
  certificationState: "validating", route: "local", processingLocation: "appliance", precision: "bf16",
  placementClass: "protected-resident", nodeRole: "main-box", exclusive: false,
  defaults: { steps: 4, guidanceScale: 1, count: 1 },
  constraints: { negativePrompt: false, maskInpainting: false, maximumCount: 1, maximumReferenceImages: 0 } });
const unavailable = (intentKey) => ({ intentKey, modelAlias: `drawing.${intentKey}`,
  operation: "images.generations", available: false, reasonCode: "not_qualified",
  selectedProfile: null, selectedProfileId: null, selectedProfileDisplayName: null,
  certificationState: null, route: null, processingLocation: null, precision: null, placementClass: null,
  nodeRole: null, exclusive: null, defaults: null, constraints: null });

function application() {
  return { models: [{ capabilityKey: "image-generation", route: "local", routingClass: "experimental",
    available: true, intentRouter: { schema: "teamaibox.drawing-intents.v2",
      policyVersion: "protected-main-default.v1", actualProfileDisclosureRequired: true,
      externalProcessingDisclosureRequired: false,
      ordinaryPolicy: { fallbackAllowed: false, requiredPlacementClass: "protected-resident",
        requiredNodeRole: "main-box", selectedProfile: MAIN, selectedProfileId: MAIN_ID },
      intents: [available("automatic"), available("fast")] } }] };
}

test("accepts only the local office drawing choices", () => {
  const value = parseDrawingIntentRouterV2(application());
  assert.equal(value.schema, "teamaibox.drawing-intents.v2");
  assert.equal(value.ordinaryPolicy.fallbackAllowed, false);
  assert.deepEqual(value.intents.map((intent) => intent.intentKey), ["automatic", "fast"]);
  assert.equal(value.intents.every((intent) => intent.selectedProfile === MAIN), true);
  assert.deepEqual(drawingIntentKeysV2, ["automatic", "fast"]);
  assert.equal(preferredDrawingIntentV2(value).intentKey, "automatic");
  assert.equal(preferredDrawingIntentV2(value, "fast").intentKey, "fast");
});

test("rejects non-local routes, fallback, and extra intent choices", () => {
  const nonLocal = application();
  nonLocal.models[0].intentRouter.intents[0].route = "external";
  nonLocal.models[0].intentRouter.intents[0].processingLocation = "remote";
  assert.equal(parseDrawingIntentRouterV2(nonLocal), null);
  const fallback = application();
  fallback.models[0].intentRouter.ordinaryPolicy.fallbackAllowed = true;
  assert.equal(parseDrawingIntentRouterV2(fallback), null);
  const extra = application();
  extra.models[0].intentRouter.intents.push(unavailable("unsupported"));
  assert.equal(parseDrawingIntentRouterV2(extra), null);
});

test("accepts a declared local successor and rejects inconsistent profile identity", () => {
  const value = application();
  for (const intent of value.models[0].intentRouter.intents) {
    intent.selectedProfile = "drawing.office-local.successor";
    intent.selectedProfileId = "00000000-0000-4000-8000-000000000001";
  }
  value.models[0].intentRouter.ordinaryPolicy.selectedProfile = "drawing.office-local.successor";
  value.models[0].intentRouter.ordinaryPolicy.selectedProfileId = "00000000-0000-4000-8000-000000000001";
  assert.ok(parseDrawingIntentRouterV2(value));
  value.models[0].intentRouter.intents[1].selectedProfileId = MAIN_ID;
  assert.equal(parseDrawingIntentRouterV2(value), null);
});

test("accepts declared model capacity without arbitrary frontend numeric ceilings", () => {
  const value = application();
  const item = value.models[0].intentRouter.intents[0];
  item.defaults = { steps: 201, guidanceScale: 31, count: 9 };
  item.constraints = { ...item.constraints, maximumCount: 9, maximumWidth: 32768 };
  assert.ok(parseDrawingIntentRouterV2(value));
  item.defaults.count = 0;
  assert.equal(parseDrawingIntentRouterV2(value), null);
});

test("unavailable office service has no fallback and does not leak stale profile facts", () => {
  const value = application();
  value.models[0].intentRouter.intents = [unavailable("automatic"), unavailable("fast")];
  value.models[0].intentRouter.ordinaryPolicy.selectedProfile = null;
  value.models[0].intentRouter.ordinaryPolicy.selectedProfileId = null;
  const parsed = parseDrawingIntentRouterV2(value);
  assert.ok(parsed);
  assert.equal(preferredDrawingIntentV2(parsed), null);
  value.models[0].intentRouter.intents[0].selectedProfileDisplayName = "Stale profile";
  assert.equal(parseDrawingIntentRouterV2(value), null);
  const partial = application();
  partial.models[0].intentRouter.intents[1] = unavailable("fast");
  assert.equal(parseDrawingIntentRouterV2(partial), null);
});
