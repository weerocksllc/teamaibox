import assert from "node:assert/strict";
import test from "node:test";

import { ExternalProviderContractTester, NodeHttpsProviderTransport } from "../src/external-provider-contract-tester.mjs";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function provider(overrides = {}) {
  return {
    providerKey: "external.lab",
    endpoint: "https://a100.lab.example/v1",
    auth: { scheme: "bearer", headerName: "Authorization" },
    trust: { mode: "system_ca", serverName: null },
    healthCheck: { path: "/models" },
    timeouts: { requestMilliseconds: 10_000 },
    modelMappings: [
      { modelProfileId: uuid(1), providerModelName: "large-chat", enabled: true, operations: ["responses", "chat.completions"] },
      { modelProfileId: uuid(2), providerModelName: "large-embedding", enabled: true, operations: ["embeddings"] },
    ],
    ...structuredClone(overrides),
  };
}

test("contract tester proves health, model publication, and every declared operation without retaining output", async () => {
  const calls = [];
  const transport = { async request(input) {
    calls.push(input);
    if (input.method === "GET") return { status: 200, latencyMilliseconds: 2, body: { object: "list", data: [{ id: "large-chat" }, { id: "large-embedding" }] } };
    if (input.path === "/responses") return { status: 200, latencyMilliseconds: 4, body: { id: "resp_contract", status: "completed", output: [] } };
    if (input.path === "/chat/completions") return { status: 200, latencyMilliseconds: 5, body: { choices: [{ message: { role: "assistant", content: "OK" } }] } };
    return { status: 200, latencyMilliseconds: 3, body: { data: [{ embedding: [0.1, 0.2] }] } };
  } };
  const result = await new ExternalProviderContractTester({ transport }).run({ provider: provider(), credential: Buffer.from("secret-token"), signal: AbortSignal.timeout(1_000) });
  assert.equal(result.passed, true);
  assert.match(result.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(calls.length, 4);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  assert.equal(JSON.stringify(result).includes("OK"), false);
});

test("missing model and invalid built-in OCR response schema fail closed", async () => {
  const transport = { async request(input) {
    if (input.method === "GET") return { status: 200, latencyMilliseconds: 1, body: { object: "list", data: [] } };
    return { status: 200, latencyMilliseconds: 1, body: { unexpected: true } };
  } };
  const value = provider({ modelMappings: [{ modelProfileId: uuid(3), providerModelName: "ocr-large", enabled: true, operations: ["ocr"], contextWindow: 1 }] });
  const result = await new ExternalProviderContractTester({ transport }).run({ provider: value, credential: Buffer.from("secret-token") });
  assert.equal(result.passed, false);
  assert.ok(result.failedChecks.includes(`model_missing:${uuid(3)}`));
  assert.ok(result.failedChecks.includes(`operation_schema:ocr:${uuid(3)}`));
});

test("provider errors become bounded failed checks without response bodies or credentials", async () => {
  const transport = { async request() { const error = new Error("raw upstream body with secret-token"); error.code = "provider_timeout"; throw error; } };
  const result = await new ExternalProviderContractTester({ transport }).run({ provider: provider(), credential: Buffer.from("secret-token") });
  assert.equal(result.passed, false);
  assert.ok(result.failedChecks.some((item) => item.includes("provider_timeout")));
  assert.equal(JSON.stringify(result).includes("raw upstream"), false);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
});

test("custom operation fixtures pass only bounded non-authority headers to the transport", async () => {
  const calls = [];
  const transport = { async request(input) {
    calls.push(input);
    if (input.method === "GET") return { status: 200, latencyMilliseconds: 1, body: { object: "list", data: [{ id: "ocr-large" }] } };
    return { status: 200, latencyMilliseconds: 1, body: { text: "recognized" } };
  } };
  const value = provider({ modelMappings: [{ modelProfileId: uuid(3), providerModelName: "ocr-large", enabled: true, operations: ["ocr.custom"] }] });
  const tester = new ExternalProviderContractTester({ transport, fixtureProvider: async () => ({
    method: "POST", path: "/ocr", body: { model: "ocr-large", object_ref: "fixture" },
    headers: { "Idempotency-Key": "contract-probe-ocr" }, validate: (response) => response.body?.text === "recognized",
  }) });
  const result = await tester.run({ provider: value, credential: Buffer.from("secret-token") });
  assert.equal(result.passed, true);
  assert.deepEqual(calls.at(-1).headers, { "Idempotency-Key": "contract-probe-ocr" });
});

test("resource-controlled contract probes prepare each model and always unload it", async () => {
  const calls = [];
  const value = provider({
    resourceControl: { mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload", statusPath: "/models/status", idleSeconds: 180 },
    modelMappings: [{ modelProfileId: uuid(4), providerModelName: "drawing-large", enabled: true, operations: ["images.generations", "images.edits"] }],
  });
  const transport = { async request(input) {
    calls.push({ method: input.method, path: input.path, model: input.body?.model ?? null });
    if (input.method === "GET") return { status: 200, latencyMilliseconds: 1, body: { object: "list", data: [{ id: "drawing-large" }] } };
    if (input.path === "/models/prepare") return { status: 200, latencyMilliseconds: 2, body: { status: "ready", loaded: true, model: "drawing-large" } };
    if (input.path === "/models/unload") return { status: 200, latencyMilliseconds: 2, body: { status: "unloaded", loaded: false, model: "drawing-large" } };
    return { status: 200, latencyMilliseconds: 3, body: { data: [{ b64_json: "not-retained" }] } };
  } };
  const result = await new ExternalProviderContractTester({ transport }).run({ provider: value, credential: Buffer.from("secret-token") });
  assert.equal(result.passed, true);
  assert.deepEqual(calls.map((call) => call.path), ["/models", "/models/prepare", "/images/generations", "/images/edits", "/models/unload"]);
  assert.equal(result.evidence.resourceControlMode, "model_api");
  assert.equal(JSON.stringify(result).includes("not-retained"), false);
});

test("resource prepare failure skips model operations but still unloads fail closed", async () => {
  const calls = [];
  const value = provider({
    resourceControl: { mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload", statusPath: "/models/status", idleSeconds: 180 },
    modelMappings: [{ modelProfileId: uuid(5), providerModelName: "drawing-large", enabled: true, operations: ["images.generations"] }],
  });
  const transport = { async request(input) {
    calls.push(input.path);
    if (input.method === "GET") return { status: 200, latencyMilliseconds: 1, body: { object: "list", data: [{ id: "drawing-large" }] } };
    if (input.path === "/models/prepare") return { status: 503, latencyMilliseconds: 2, body: { error: { message: "secret upstream detail" } } };
    return { status: 200, latencyMilliseconds: 2, body: { status: "unloaded", loaded: false, model: "drawing-large" } };
  } };
  const result = await new ExternalProviderContractTester({ transport }).run({ provider: value, credential: Buffer.from("secret-token") });
  assert.equal(result.passed, false);
  assert.deepEqual(calls, ["/models", "/models/prepare", "/models/unload"]);
  assert.ok(result.failedChecks.includes(`resource_prepare_schema:${uuid(5)}`));
  assert.ok(result.failedChecks.includes(`operation_not_probed:images.generations:${uuid(5)}`));
  assert.equal(JSON.stringify(result).includes("secret upstream detail"), false);
});

test("resource unload schema failure fails an otherwise valid contract", async () => {
  const value = provider({
    resourceControl: { mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload", statusPath: "/models/status", idleSeconds: 180 },
    modelMappings: [{ modelProfileId: uuid(6), providerModelName: "drawing-large", enabled: true, operations: ["images.generations"] }],
  });
  const transport = { async request(input) {
    if (input.method === "GET") return { status: 200, latencyMilliseconds: 1, body: { object: "list", data: [{ id: "drawing-large" }] } };
    if (input.path === "/models/prepare") return { status: 200, latencyMilliseconds: 1, body: { status: "ready", loaded: true, model: "drawing-large" } };
    if (input.path === "/models/unload") return { status: 200, latencyMilliseconds: 1, body: { status: "ready", loaded: true, model: "drawing-large" } };
    return { status: 200, latencyMilliseconds: 1, body: { data: [{ b64_json: "image" }] } };
  } };
  const result = await new ExternalProviderContractTester({ transport }).run({ provider: value, credential: Buffer.from("secret-token") });
  assert.equal(result.passed, false);
  assert.ok(result.failedChecks.includes(`resource_unload_schema:${uuid(6)}`));
});

test("Node HTTPS transport rejects probe headers that could replace authority framing or credentials", async () => {
  const transport = new NodeHttpsProviderTransport();
  for (const headers of [
    { Authorization: "Bearer attacker" }, { Host: "evil.test" }, { "Content-Length": "1" },
    { "X-Probe": "good\r\nInjected: bad" },
  ]) {
    await assert.rejects(transport.request({
      provider: provider(), credential: Buffer.from("secret-token"), customCa: null,
      method: "GET", path: "/models", headers, timeoutMilliseconds: 1000,
    }), { code: "provider_probe_headers_invalid" });
  }
});
