import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const contractRoot = new URL("../", import.meta.url);
const extensionContracts = Object.freeze({
  "openai-request-extension": ["openai/request-extension.v1.schema.json", "openai", "request"],
  "http-compute-job": ["http/compute-job.v1.schema.json", "http", "response"],
  "http-ocr-submission": ["http/ocr-submission.v1.schema.json", "http", "request"],
  "http-translation-submission": ["http/translation-submission.v1.schema.json", "http", "request"],
  "http-ocr-result": ["http/ocr-result.v1.schema.json", "http", "response"],
  "http-asr-submission": ["http/asr-submission.v1.schema.json", "http", "request"],
  "http-asr-result": ["http/asr-result.v1.schema.json", "http", "response"],
  "http-translation-result": ["http/translation-result.v1.schema.json", "http", "response"],
  "http-realtime-admission": ["http/realtime-admission.v1.schema.json", "http", "request"],
  "http-realtime-session": ["http/realtime-session.v1.schema.json", "http", "response"],
  "http-assistant-submission": ["http/assistant-submission.v1.schema.json", "http", "request"],
  "http-assistant-conversation": ["http/assistant-conversation.v1.schema.json", "http", "response"],
  "http-assistant-event": ["http/assistant-event.v1.schema.json", "http", "response"],
  "http-image-edit-submission": ["http/image-edit-submission.v1.schema.json", "http", "request"],
  "http-image-result": ["http/image-result.v1.schema.json", "http", "response"],
});

async function load(relative) {
  return JSON.parse(await readFile(new URL(relative, contractRoot), "utf8"));
}

test("catalogs every public compute API extension with matching v1 metadata", async () => {
  const catalog = await load("catalog.v1.json");
  const byId = new Map(catalog.contracts.map((entry) => [entry.id, entry]));
  for (const [id, [path, family, role]] of Object.entries(extensionContracts)) {
    assert.deepEqual(byId.get(id), {
      id,
      family,
      major: 1,
      role,
      stability: "stable",
      path,
    });
    const schema = await load(path);
    assert.equal(schema.$id, `https://schemas.teamaibox.local/${path}`);
    assert.deepEqual(schema["x-teamaibox-contract"], { family, role, major: 1 });
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
  }
});

test("extension schemas expose logical profiles and scoped references, never physical routes or credentials", async () => {
  const serialized = JSON.stringify(await Promise.all(
    Object.values(extensionContracts).map(([path]) => load(path)),
  ));
  for (const forbidden of [
    "container_address", "container_id", "endpoint_uri", "node_id", "provider_id",
    "worker_address", "worker_id", "access_key", "secret_key",
  ]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false, forbidden);
  }
  const ocr = await load("http/ocr-submission.v1.schema.json");
  assert.deepEqual(ocr.properties.input.required, ["reference_id"]);
  const translation = await load("http/translation-submission.v1.schema.json");
  assert.equal(translation.oneOf.length, 2);
  assert.deepEqual(translation.properties.input_kind.enum, ["text", "image", "document", "audio", "video"]);
  assert.deepEqual(translation.properties.input_representation.enum, ["source", "ocr-result", "asr-result"]);
  const ocrResult = await load("http/ocr-result.v1.schema.json");
  assert.equal(ocrResult.properties.schema.const, "teamaibox.ai.ocr-result.v1");
  const asr = await load("http/asr-submission.v1.schema.json");
  assert.deepEqual(asr.properties.input.required, ["reference_id"]);
  const asrResult = await load("http/asr-result.v1.schema.json");
  assert.equal(asrResult.properties.schema.const, "teamaibox.ai.asr-result.v1");
  assert.ok(asrResult.required.includes("provenance"));
  const translationResult = await load("http/translation-result.v1.schema.json");
  assert.equal(translationResult.properties.schema.const, "teamaibox.ai.translation-result.v1");
  assert.ok(translationResult.required.includes("workflow"));
  const imageEdit = await load("http/image-edit-submission.v1.schema.json");
  assert.deepEqual(imageEdit.properties.input.required, ["reference_id"]);
  const imageResult = await load("http/image-result.v1.schema.json");
  assert.equal(imageResult.properties.schema.const, "teamaibox.ai.image-result.v1");
  assert.equal(imageResult.properties.outputs.items.properties.encrypted.const, true);
  const realtime = await load("http/realtime-session.v1.schema.json");
  assert.equal(realtime.properties.protocol_version.const, 1);
  assert.equal(realtime.properties.reservation.properties.priority_class.const, "latency");
  assert.equal(realtime.properties.reservation.properties.protected_from_batch.const, true);
  assert.deepEqual(
    realtime.properties.reservation.properties.resources.required.slice(-2),
    ["codec_encode_sessions", "codec_decode_sessions"],
  );
  const job = await load("http/compute-job.v1.schema.json");
  assert.ok(job.required.includes("result"));
  assert.deepEqual(job.properties.result.type, ["object", "null"]);
});
