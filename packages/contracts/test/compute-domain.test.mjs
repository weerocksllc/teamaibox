import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const contractRoot = new URL("../", import.meta.url);
const computeContracts = Object.freeze({
  "compute-capability": "compute/capability.v1.schema.json",
  "compute-model-profile": "compute/model-profile.v1.schema.json",
  "compute-job": "compute/job.v1.schema.json",
  "compute-attempt": "compute/attempt.v1.schema.json",
  "compute-reservation": "compute/reservation.v1.schema.json",
  "compute-worker-instance": "compute/worker-instance.v1.schema.json",
  "compute-artifact-ref": "compute/artifact-ref.v1.schema.json",
  "compute-provider-error": "compute/provider-error.v1.schema.json",
});

async function load(relative) {
  return JSON.parse(await readFile(new URL(relative, contractRoot), "utf8"));
}

function propertyNames(schema, output = []) {
  if (!schema || typeof schema !== "object") return output;
  if (schema.properties && typeof schema.properties === "object") {
    output.push(...Object.keys(schema.properties));
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) value.forEach((child) => propertyNames(child, output));
    else if (value && typeof value === "object") propertyNames(value, output);
  }
  return output;
}

test("publishes compute.v1 logical contracts with matching catalog metadata", async () => {
  const catalog = await load("catalog.v1.json");
  const compute = catalog.contracts.filter((entry) => entry.family === "compute");
  assert.deepEqual(new Set(compute.map((entry) => entry.id)), new Set(Object.keys(computeContracts)));
  for (const entry of compute) {
    assert.equal(entry.path, computeContracts[entry.id]);
    const schema = await load(entry.path);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.ok(schema.$id.endsWith(`/${entry.path}`));
    assert.deepEqual(schema["x-teamaibox-contract"], {
      family: "compute",
      role: entry.role,
      major: 1,
    });
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.length > 0);
  }
});

test("model profiles are immutable, digest pinned, NVFP4 aware, and use unified-memory envelopes", async () => {
  const profile = await load(computeContracts["compute-model-profile"]);
  assert.ok(profile.required.includes("artifactDigest"));
  assert.ok(profile.required.includes("resourceEnvelope"));
  assert.ok(profile.required.includes("executionKind"));
  assert.ok(profile.required.includes("artifacts"));
  assert.ok(profile.required.includes("coldStart"));
  assert.ok(profile.required.includes("validationEvidence"));
  assert.ok(profile.properties.precision.enum.includes("nvfp4"));
  assert.equal(profile.properties.artifactDigest.$ref, "#/$defs/digest");
  assert.ok(profile.$defs.source.properties.license.required.includes("reviewStatus"));
  assert.ok(profile.$defs.engine.required.includes("imageDigest"));
  assert.ok(profile.$defs.engine.required.includes("configurationDigest"));
  assert.ok(profile.$defs.quantizationRecipe.required.includes("recipeDigest"));
  assert.ok(profile.$defs.compatibility.properties.hardware.required.includes("minimumUnifiedMemoryBytes"));
  assert.ok(profile.$defs.limits.required.includes("maximumConcurrentRequests"));
  assert.ok(profile.$defs.resourceEnvelope.required.includes("unifiedMemoryBytes"));
  assert.ok(profile.$defs.resourceEnvelope.required.includes("accountingMode"));
  assert.equal("dedicatedVramBytes" in profile.$defs.resourceEnvelope.properties, false);
  assert.equal("updatedAt" in profile.properties, false);
});

test("attempt and provider errors preserve acceptance, retry, and replay safety", async () => {
  const attempt = await load(computeContracts["compute-attempt"]);
  const provider = await load(computeContracts["compute-provider-error"]);
  assert.ok(attempt.required.includes("acceptanceState"));
  assert.ok(attempt.required.includes("retryClassification"));
  assert.ok(provider.required.includes("replaySafety"));
  assert.ok(provider.properties.acceptanceState.enum.includes("side_effect_uncertain"));
  assert.ok(provider.properties.replaySafety.enum.includes("unsafe_after_output"));
  assert.ok(provider.properties.replaySafety.enum.includes("non_replayable"));
});

test("logical compute schemas carry references and identities, never bearer credentials or container addresses", async () => {
  const forbidden = new Set([
    "accessKey", "apiKey", "containerAddress", "containerId", "credential",
    "leaseToken", "password", "rawResponse", "secret", "signedToken",
  ]);
  for (const relative of Object.values(computeContracts)) {
    const schema = await load(relative);
    const found = propertyNames(schema).filter((name) => forbidden.has(name));
    assert.deepEqual(found, [], `${relative} exposes sensitive or physical routing fields`);
  }
  const artifact = await load(computeContracts["compute-artifact-ref"]);
  assert.deepEqual(new Set(Object.keys(artifact.properties.object.properties)),
    new Set(["objectId", "objectVersion", "referenceId"]));
  const reservation = await load(computeContracts["compute-reservation"]);
  assert.ok(reservation.required.includes("leaseId"));
  assert.ok(reservation.required.includes("fencingToken"));
});
