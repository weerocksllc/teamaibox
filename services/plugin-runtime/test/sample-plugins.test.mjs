import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createWorkerControlEnvelope, assertWorkerControlResponse } from "../../scheduler/src/worker-control-protocol.mjs";
import { createTeamNotesApplication } from "../../../examples/plugins/team-notes/src/application.mjs";
import { createTeamNotesServer } from "../../../examples/plugins/team-notes/src/server.mjs";
import { createTextTransformWorker } from "../../../examples/plugins/text-transform-worker/src/worker.mjs";
import { createTextTransformServer } from "../../../examples/plugins/text-transform-worker/src/server.mjs";
import { PluginCompatibilitySuiteV1 } from "../src/plugin-compatibility-suite.mjs";
import { PluginSandboxPolicy } from "../src/sandbox-policy.mjs";

const root = new URL("../../../", import.meta.url);
const appManifest = JSON.parse(await readFile(new URL("examples/plugins/team-notes/manifest.json", root), "utf8"));
const computeManifest = JSON.parse(await readFile(new URL("examples/plugins/text-transform-worker/manifest.json", root), "utf8"));
const publicKey = await readFile(new URL("examples/plugins/example-community-public-key.pem", root), "utf8");
const sandboxPolicy = JSON.parse(await readFile(new URL("deploy/plugins/sandbox-policy.v1.json", root), "utf8"));
const token = `taibp_v1_${Buffer.alloc(32, 17).toString("base64url")}`;
const workerId = "00000000-0000-4000-8000-000000001101";
const profileId = "00000000-0000-4000-8000-000000001102";
const leaseId = "00000000-0000-4000-8000-000000001103";

async function listen(server) {
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(type, payload, { jobId = null, attemptId = null } = {}) {
  return createWorkerControlEnvelope({
    workerId,
    type,
    correlationId: "sample-plugin-request-0001",
    jobId,
    attemptId,
    leaseId,
    fencingToken: 9,
    payload,
    sentAt: new Date("2026-08-11T05:00:00Z"),
  });
}

test("sample ApplicationPlugin calls the documented delegated API without leaking the token into URL or body", async () => {
  const calls = [];
  let tokenRequests = 0;
  const application = createTeamNotesApplication({
    baseUrl: "https://box.example.test",
    async tokenProvider() { tokenRequests += 1; return token; },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return { ok: true, status: 200, async json() { return { entries: [{ name: "roadmap.md" }] }; } };
    },
  });
  const result = await application.listNotes("team-alpha");
  assert.deepEqual(result, { entries: [{ name: "roadmap.md" }] });
  assert.equal(calls[0].url, "https://box.example.test/api/plugin/v1/invoke");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);
  assert.equal(calls[0].url.includes(token), false);
  assert.equal(calls[0].options.body.includes(token), false);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schemaVersion: 1,
    scope: "files:read",
    resource: { kind: "team", key: "team-alpha" },
    operation: "files.list",
    body: { path: "/notes", pageSize: 50 },
  });
  assert.equal(tokenRequests, 1);
});

test("sample ApplicationPlugin serves bounded health and the public live preference SDK client", async () => {
  const server = createTeamNotesServer();
  const baseUrl = await listen(server);
  try {
    const health = await fetch(`${baseUrl}/health/ready`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ready", pluginId: "example.team-notes" });
    const page = await fetch(`${baseUrl}/plugins/example.team-notes`);
    const source = await page.text();
    assert.equal(page.status, 200);
    assert.match(source, /color-scheme/);
    assert.match(source, /id="note-draft"/);
    assert.match(source, /browser\.mjs/);
    assert.match(source, /styles\.css/);
    assert.doesNotMatch(source, /<style>/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
    assert.doesNotMatch(page.headers.get("content-security-policy"), /unsafe-inline/);
    const browser = await (await fetch(`${baseUrl}/plugins/example.team-notes/browser.mjs`)).text();
    assert.match(browser, /subscribePluginPreferenceMessagesV1/);
    assert.match(browser, /applyPluginPreferenceSnapshotV1/);
    const preferences = await (await fetch(`${baseUrl}/plugins/example.team-notes/preferences-v1.mjs`)).text();
    assert.match(preferences, /export function applyPluginPreferenceSnapshotV1/);
    const styles = await fetch(`${baseUrl}/plugins/example.team-notes/styles.css`);
    assert.equal(styles.status, 200);
    assert.match(styles.headers.get("content-type"), /text\/css/);
    assert.match(await styles.text(), /\.status\s*\{/);
  } finally { await close(server); }
});

test("sample ComputePlugin implements fenced prepare, execute, cancel, and unload through public worker-control v1", () => {
  const worker = createTextTransformWorker({ modelProfileId: profileId });
  const prepare = request("worker.prepare.request", { generation: 1, modelProfileId: profileId });
  const ready = assertWorkerControlResponse(prepare, worker.handle(prepare), ["worker.prepare.ready"]);
  assert.deepEqual(ready.payload.capabilityClaims, [{ modelProfileId: profileId, operations: ["responses"] }]);
  const jobId = "00000000-0000-4000-8000-000000001104";
  const attemptId = "00000000-0000-4000-8000-000000001105";
  const execute = request("worker.execute.request", { generation: 1, input: { text: "edge box" } }, { jobId, attemptId });
  const result = assertWorkerControlResponse(execute, worker.handle(execute), ["worker.execute.succeeded"]);
  assert.deepEqual(result.payload, { result: { text: "EDGE BOX" }, artifactRefs: [], generation: 1 });
  const cancel = request("worker.cancel.request", { generation: 1 }, { jobId, attemptId });
  assert.equal(assertWorkerControlResponse(cancel, worker.handle(cancel), ["worker.cancel.accepted"]).payload.generation, 1);
  const unload = request("worker.unload.request", { generation: 1 });
  assert.equal(assertWorkerControlResponse(unload, worker.handle(unload), ["worker.unload.succeeded"]).payload.generation, 1);
  assert.equal(worker.ready(), false);
});

test("sample ComputePlugin cooperatively cancels an active delayed validation request", async () => {
  const worker = createTextTransformWorker({ modelProfileId: profileId });
  worker.handle(request("worker.prepare.request", { generation: 1, modelProfileId: profileId }));
  const jobId = "00000000-0000-4000-8000-000000001114";
  const attemptId = "00000000-0000-4000-8000-000000001115";
  const execute = request("worker.execute.request", {
    generation: 1, input: { text: "must not complete", x_teamaibox_test_delay_ms: 10_000 },
  }, { jobId, attemptId });
  const pending = worker.handle(execute);
  const cancel = request("worker.cancel.request", { generation: 1 }, { jobId, attemptId });
  const accepted = worker.handle(cancel);
  assert.equal(assertWorkerControlResponse(cancel, accepted, ["worker.cancel.accepted"]).type, "worker.cancel.accepted");
  const terminal = assertWorkerControlResponse(execute, await pending, ["worker.execute.cancelled"]);
  assert.equal(terminal.payload.reason, "cooperative_cancellation");
});

test("sample ComputePlugin HTTP boundary rejects malformed control input without exposing an alternate registry API", async () => {
  const server = createTextTransformServer({ modelProfileId: profileId });
  const baseUrl = await listen(server);
  try {
    const malformed = await fetch(`${baseUrl}/v1/worker/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "register-capability", userToken: token }),
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: { code: "worker_protocol_invalid" } });
    const missing = await fetch(`${baseUrl}/v1/capabilities/register`, { method: "POST" });
    assert.equal(missing.status, 404);
  } finally { await close(server); }
});

test("both third-party plugin types pass the uniform official-and-third-party compatibility suite", async () => {
  const sandbox = new PluginSandboxPolicy({
    policy: sandboxPolicy,
    auditSink: { async record() {} },
    clock: () => new Date("2026-08-11T05:00:00Z"),
  });
  const suite = new PluginCompatibilitySuiteV1({
    trustStore: {
      async resolve(keyId) {
        return keyId === "example.community/sample-release-2026"
          ? { status: "active", publisherId: "example.community", publicKey }
          : null;
      },
    },
    sandboxPolicy: sandbox,
    runtimeProbe: {
      async probe({ manifest }) {
        if (manifest.type === "ApplicationPlugin") {
          const server = createTeamNotesServer();
          const baseUrl = await listen(server);
          try {
            if (!(await fetch(`${baseUrl}/health/ready`)).ok) throw new Error("health failed");
          } finally { await close(server); }
          return {
            health: "passed", externalDependencies: 0, hostInterfaces: 0,
            apiSurface: "documented-v1", delegatedUserApi: true,
            userTokenPersisted: false, devicesObserved: 0,
          };
        }
        const worker = createTextTransformWorker({ modelProfileId: profileId });
        const prepare = request("worker.prepare.request", { generation: 1, modelProfileId: profileId });
        assertWorkerControlResponse(prepare, worker.handle(prepare), ["worker.prepare.ready"]);
        return {
          health: "passed", externalDependencies: 0, hostInterfaces: 0,
          apiSurface: "documented-v1", workerControlV1: true,
          schedulerOnlyRegistration: true, userTokenObserved: false,
        };
      },
    },
  });
  const results = [];
  for (const manifest of [appManifest, computeManifest]) results.push(await suite.certify({ manifest }));
  assert.deepEqual(results.map(({ suite: name }) => name), [
    "teamaibox.plugin-compatibility/v1",
    "teamaibox.plugin-compatibility/v1",
  ]);
  assert.ok(results.every(({ policyClass }) => policyClass === "uniform-official-and-third-party"));
  assert.deepEqual(results.map(({ pluginType }) => pluginType), ["ApplicationPlugin", "ComputePlugin"]);
});

test("sample Dockerfiles are dependency-free, non-root, and do not grant host or device access", async () => {
  for (const path of [
    "examples/plugins/team-notes/Dockerfile",
    "examples/plugins/text-transform-worker/Dockerfile",
  ]) {
    const source = await readFile(new URL(path, root), "utf8");
    assert.match(source, /USER 10001:10001/);
    assert.match(source, /ARG NODE_IMAGE/);
    assert.equal(/\b(?:apt|apk|npm|pip)\b/.test(source), false);
    assert.equal(/docker\.sock|--privileged|--gpus|host network/i.test(source), false);
  }
});
