import assert from "node:assert/strict";
import { test } from "node:test";

import { drawingIntentCatalogV1 } from "../src/applications/drawing-intent-router.mjs";

const FLUX = "drawing.flux2-klein-4b.nvfp4.spark23.provider.v1";
const QWEN = "drawing.qwen-image-2512-lightning.bf16.spark-worker02.v1";
const LONGCAT = "drawing.longcat-image.bf16.spark-worker02.v1";

test("publishes the exact FLUX validating boundary for automatic, fast, and editing intents", () => {
  const value = drawingIntentCatalogV1({ certifiedProfiles: [], experimentalProfiles: [FLUX],
    localRoutableProfiles: [], providerRoutableProfiles: [FLUX] });
  assert.equal(value.schema, "teamaibox.drawing-intents.v1");
  assert.equal(value.actualProfileDisclosureRequired, true);
  for (const key of ["automatic", "fast", "editing"]) {
    const intent = value.intents.find((item) => item.intentKey === key);
    assert.equal(intent.available, true);
    assert.equal(intent.selectedProfile, FLUX);
    assert.equal(intent.selectedProfileId, "bc266009-bf57-589e-b8c4-dcf9ec892692");
    assert.equal(intent.certificationState, "validating");
    assert.equal(intent.route, "external");
    assert.equal(intent.processingLocation, "managed_lan_node");
    assert.equal(intent.defaults.steps, 4);
    assert.equal(intent.defaults.guidanceScale, 1);
    assert.equal(intent.constraints.negativePrompt, false);
    assert.equal(intent.constraints.maskInpainting, false);
  }
});

test("truthfully disables unqualified specialist intents", () => {
  const value = drawingIntentCatalogV1({ certifiedProfiles: [], experimentalProfiles: [FLUX],
    localRoutableProfiles: [], providerRoutableProfiles: [FLUX] });
  assert.deepEqual(value.intents.filter((item) => !item.available).map((item) => item.intentKey),
    ["high-quality", "chinese-poster", "infographic"]);
  assert.equal(value.intents.find((item) => item.intentKey === "chinese-poster").reasonCode,
    "typography_profile_not_qualified");
});

test("prefers a local candidate and never treats a legacy profile as an automatic route", () => {
  const value = drawingIntentCatalogV1({ certifiedProfiles: [FLUX],
    experimentalProfiles: ["drawing.sdxl-base-1.0.fp16.spark23.provider.v1"],
    localRoutableProfiles: [FLUX], providerRoutableProfiles: ["drawing.sdxl-base-1.0.fp16.spark23.provider.v1"] });
  const automatic = value.intents.find((item) => item.intentKey === "automatic");
  assert.equal(automatic.available, true);
  assert.equal(automatic.route, "local");
  assert.equal(automatic.certificationState, "certified");
});

test("fails closed when routable-profile facts are empty", () => {
  const value = drawingIntentCatalogV1({ certifiedProfiles: [FLUX], experimentalProfiles: [],
    localRoutableProfiles: [], providerRoutableProfiles: [] });
  assert.equal(value.intents.every((item) => item.available === false), true);
});

test("uses the exact accepted two-profile intent defaults without enabling LongCat editing", () => {
  const value = drawingIntentCatalogV1({ certifiedProfiles: [],
    experimentalProfiles: [QWEN, LONGCAT, FLUX], localRoutableProfiles: [],
    providerRoutableProfiles: [QWEN, LONGCAT, FLUX] });
  const selected = Object.fromEntries(value.intents.map((item) => [item.intentKey, item]));
  assert.equal(selected.automatic.selectedProfile, QWEN);
  assert.equal(selected.automatic.selectedProfileId, "6e079903-18e3-5303-a742-d57054610520");
  assert.equal(selected.fast.selectedProfile, QWEN);
  assert.equal(selected["high-quality"].selectedProfile, LONGCAT);
  assert.equal(selected["high-quality"].selectedProfileId, "d7558513-386f-51ee-8e78-8c4e18f6d3cf");
  assert.equal(selected["chinese-poster"].selectedProfile, LONGCAT);
  assert.equal(selected.infographic.available, false);
  assert.equal(selected.editing.selectedProfile, FLUX);
  assert.equal(selected.automatic.defaults.steps, 4);
  assert.equal(selected["high-quality"].defaults.steps, 50);
});
