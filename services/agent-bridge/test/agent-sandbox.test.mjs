import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AgentSandboxManager } from "../src/agent-sandbox-manager.mjs";
import { AgentSandboxPolicy } from "../src/agent-sandbox-policy.mjs";
import { MemoryAgentSandboxRepository } from "../src/memory-sandbox-repository.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c017419958a";
const OTHER_OWNER = "018f6f18-24d7-7c21-9b62-8c017419958b";
const IMAGE = `registry.local/teamaibox/agent-sandbox@sha256:${"a".repeat(64)}`;
const NODE = "018f6f18-24d7-7c21-9b62-8c017419958c";
const POLICY = JSON.parse(await readFile(new URL("../../../deploy/agent/sandbox-policy.v1.json", import.meta.url), "utf8"));
const EGRESS_POLICY = JSON.parse(await readFile(new URL("../../../deploy/agent/egress-policy.v1.json", import.meta.url), "utf8"));

function policy(egressPolicy = EGRESS_POLICY) {
  return new AgentSandboxPolicy({ policy: POLICY, egressPolicy });
}

function projectionEvidence(input) {
  return {
    workerId: input.workerId,
    fileClass: input.fileClass,
    contentSha256: input.contentSha256,
    bytes: Buffer.from(input.contentBase64, "base64").length,
  };
}

test('offline image sandbox accepts a full local content ID but not a mutable tag', () => {
  const input = { ownerIdentityId: OWNER, workerId: '018f6f18-24d7-7c21-9b62-8c017419958d', image: 'sha256:' + 'b'.repeat(64) };
  assert.equal(policy().compile(input).nodeSpec.image, input.image);
  assert.throws(() => policy().compile({...input, image: 'local/sandbox:latest'}));
});

test("sandbox policy derives one owner namespace with bounded non-root resources", () => {
  const sandboxPolicy = policy();
  const compiled = sandboxPolicy.compile({
    ownerIdentityId: OWNER,
    workerId: "018f6f18-24d7-7c21-9b62-8c017419958d",
    image: IMAGE,
  });
  assert.match(compiled.identity.sandboxKey, /^sandbox\.[a-f0-9]{32}$/);
  assert.match(compiled.identity.workspaceVolume, /^teamaibox-agent-[a-f0-9]{32}-workspace$/);
  assert.notEqual(compiled.identity.workspaceVolume, sandboxPolicy.identity(OTHER_OWNER).workspaceVolume);
  assert.equal(compiled.nodeSpec.security.runAsUid, 65532);
  assert.equal(compiled.nodeSpec.security.seccompProfile, "builtin");
  assert.equal(compiled.nodeSpec.security.dockerSocket, false);
  assert.deepEqual(compiled.nodeSpec.devices, []);
  assert.deepEqual(compiled.nodeSpec.mounts, [{
    type: "volume", source: compiled.identity.workspaceVolume, target: "/workspace", readOnly: false,
  }]);
  assert.equal(compiled.nodeSpec.limits.memoryBytes, 8 * 1024 ** 3);
  assert.equal(compiled.nodeSpec.limits.pidsLimit, 512);
  assert.equal(compiled.nodeSpec.limits.ephemeralBytes, 8 * 1024 ** 3);
  assert.equal(compiled.workspaceQuotaBytes, 100 * 1024 ** 3);
  assert.deepEqual(compiled.nodeSpec.egressHosts, ["compute-gateway", "source-gateway"]);
  assert.equal(compiled.nodeSpec.environment.PIP_INDEX_URL, "http://source-gateway:8080/pip/simple/");
  assert.equal(compiled.nodeSpec.environment.NPM_CONFIG_REGISTRY, "http://source-gateway:8080/npm/registry/");
  assert.equal(compiled.nodeSpec.environment.APT_CONFIG, "/run/teamaibox/source-config/apt/apt.conf");
  assert.equal(compiled.nodeSpec.environment.HTTP_PROXY, undefined);
  assert.match(compiled.sourceClientConfig.aptSources, /arch=arm64/);
  assert.equal(compiled.nodeSpec.environment.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.equal(compiled.nodeSpec.environment.OPENCODE_DISABLE_SHARE, "1");
  assert.equal(compiled.nodeSpec.environment.XDG_CONFIG_HOME, "/run/teamaibox/xdg-config");
  assert.equal(compiled.nodeSpec.environment.OPENCODE_CONFIG, "/run/teamaibox/xdg-config/opencode/opencode.json");
  assert.equal(compiled.nodeSpec.environment.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(compiled.nodeSpec.environment.OPENCODE_PURE, "1");
  assert.equal(compiled.nodeSpec.environment.OPENCODE_DISABLE_DEFAULT_PLUGINS, "1");
  assert.equal(compiled.nodeSpec.environment.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
  assert.equal(compiled.nodeSpec.environment.OPENCODE_DISABLE_MODELS_FETCH, "1");
  assert.equal(compiled.nodeSpec.environment.OPENCODE_DISABLE_EMBEDDED_WEB_UI, "1");
  assert.equal(compiled.nodeSpec.environment.OPENCODE_PERMISSION, '{"*":"ask"}');
  assert.ok(!JSON.stringify(compiled).includes("docker.sock"));
});

test("sandbox policy rejects mutable images, excessive quotas, host controls, GPU, and unsafe egress", () => {
  const sandboxPolicy = policy();
  const base = { ownerIdentityId: OWNER, workerId: "018f6f18-24d7-7c21-9b62-8c017419958d", image: IMAGE };
  assert.throws(() => sandboxPolicy.compile({ ...base, image: "registry.local/agent:latest" }), { code: "agent_sandbox_runtime_invalid" });
  assert.throws(() => sandboxPolicy.compile({ ...base, limits: { memoryBytes: 64 * 1024 ** 3 } }), /memory limit/);
  assert.throws(() => sandboxPolicy.compile({ ...base, requested: { dockerSocket: true } }), { code: "agent_sandbox_override_denied" });
  assert.throws(() => sandboxPolicy.compile({ ...base, requested: { devices: ["nvidia.com/gpu=all"] } }), { code: "agent_sandbox_override_denied" });
  assert.throws(() => sandboxPolicy.compile({ ...base, egressHosts: ["example.test"] }), { code: "agent_sandbox_internet_denied" });
  const enabled = structuredClone(EGRESS_POLICY);
  enabled.generalInternet.enabled = true;
  enabled.generalInternet.allowedHosts = ["api.example.test"];
  const internet = policy(enabled).compile({ ...base, egressHosts: ["api.example.test"] });
  assert.deepEqual(internet.nodeSpec.egressHosts, ["agent-egress-gateway", "api.example.test", "compute-gateway", "source-gateway"]);
  assert.equal(internet.nodeSpec.environment.HTTPS_PROXY, "http://agent-egress-gateway:8080");
  assert.throws(() => policy(enabled).compile({ ...base, egressHosts: ["other.example.test"] }), { code: "agent_sandbox_internet_denied" });
});

test("two users receive disjoint sandbox and workspace identities", () => {
  const sandboxPolicy = policy();
  const first = sandboxPolicy.identity(OWNER);
  const second = sandboxPolicy.identity(OTHER_OWNER);
  assert.notEqual(first.sandboxKey, second.sandboxKey);
  assert.notEqual(first.workspaceKey, second.workspaceKey);
  assert.notEqual(first.workspaceVolume, second.workspaceVolume);
  assert.match(first.workspaceVolume, /^teamaibox-agent-[a-f0-9]{32}-workspace$/);
  assert.match(second.workspaceVolume, /^teamaibox-agent-[a-f0-9]{32}-workspace$/);
});

test("host escape controls and direct devices are denied before runtime start", () => {
  const sandboxPolicy = policy();
  const base = { ownerIdentityId: OWNER, workerId: "018f6f18-24d7-7c21-9b62-8c017419958d", image: IMAGE };
  for (const requested of [
    { mounts: [{ type: "bind", source: "/", target: "/host" }] },
    { dockerSocket: true },
    { hostNetwork: true },
    { hostPid: true },
    { privileged: true },
    { devices: ["nvidia.com/gpu=all"] },
    { seccompProfile: "unconfined" },
  ]) {
    assert.throws(() => sandboxPolicy.compile({ ...base, requested }), { code: "agent_sandbox_override_denied" });
  }
});

test("quota pressure is bounded without weakening sandbox security", () => {
  const sandboxPolicy = policy();
  const base = { ownerIdentityId: OWNER, workerId: "018f6f18-24d7-7c21-9b62-8c017419958d", image: IMAGE };
  const maximum = {
    memoryBytes: 32 * 1024 ** 3,
    cpuQuotaMicros: 800_000,
    pidsLimit: 2048,
    ephemeralBytes: 32 * 1024 ** 3,
    workspaceQuotaBytes: 1024 * 1024 ** 3,
    openFilesLimit: 262_144,
  };
  const compiled = sandboxPolicy.compile({ ...base, limits: maximum });
  assert.equal(compiled.nodeSpec.security.readOnlyRoot, true);
  assert.equal(compiled.nodeSpec.security.noNewPrivileges, true);
  assert.deepEqual(compiled.nodeSpec.devices, []);
  for (const [name, value] of Object.entries(maximum)) {
    assert.throws(() => sandboxPolicy.compile({ ...base, limits: { [name]: value + 1 } }), /invalid/);
  }
});

test("offline package install requests remain routed to internal Pip NPM and APT gateways", () => {
  const compiled = policy().compile({
    ownerIdentityId: OWNER,
    workerId: "018f6f18-24d7-7c21-9b62-8c017419958d",
    image: IMAGE,
  });
  assert.deepEqual(compiled.nodeSpec.egressHosts, ["compute-gateway", "source-gateway"]);
  assert.equal(compiled.nodeSpec.environment.HTTP_PROXY, undefined);
  assert.match(compiled.sourceClientConfig.pipConf, /^\[global\]\nindex-url = http:\/\/source-gateway:8080\/pip\/simple/m);
  assert.match(compiled.sourceClientConfig.npmrc, /^registry=http:\/\/source-gateway:8080\/npm\//m);
  assert.match(compiled.sourceClientConfig.aptSources, /http:\/\/source-gateway:8080\/apt/);
  assert.ok(!JSON.stringify(compiled.sourceClientConfig).match(/pypi\.org|registry\.npmjs\.org|archive\.ubuntu\.com/));
});

test("network denial blocks unapproved Internet while preserving internal gateways", () => {
  const sandboxPolicy = policy();
  const base = { ownerIdentityId: OWNER, workerId: "018f6f18-24d7-7c21-9b62-8c017419958d", image: IMAGE };
  assert.throws(() => sandboxPolicy.compile({ ...base, egressHosts: ["example.com"] }), { code: "agent_sandbox_internet_denied" });
  const internal = sandboxPolicy.compile(base);
  assert.deepEqual(internal.nodeSpec.egressHosts, ["compute-gateway", "source-gateway"]);
  assert.equal(internal.nodeSpec.environment.HTTPS_PROXY, undefined);
});

test("manager starts on demand, shares one logical user sandbox, and stops only after idle", async () => {
  const starts = [];
  const stops = [];
  const projections = [];
  const audits = [];
  let now = new Date("2026-08-11T05:00:00.000Z");
  const manager = new AgentSandboxManager({
    repository: new MemoryAgentSandboxRepository(),
    policy: policy(),
    clock: () => new Date(now),
    audit: async (event) => { audits.push(event); },
    nodeAgent: {
      async startSandbox(input) {
        starts.push(structuredClone(input));
        return { nodeId: NODE, containerId: `container-${input.generation}` };
      },
      async projectSandboxFile(input) { projections.push(structuredClone(input)); return projectionEvidence(input); },
      async stopSandbox(input) { stops.push(structuredClone(input)); },
    },
  });
  const [first, second] = await Promise.all([
    manager.acquire(OWNER, { image: IMAGE }),
    manager.acquire(OWNER, { image: IMAGE }),
  ]);
  assert.equal(starts.length, 1);
  assert.equal(projections.length, 1);
  const sourceConfig = JSON.parse(Buffer.from(projections[0].contentBase64, "base64").toString());
  assert.match(sourceConfig.pipConf, /source-gateway:8080\/pip\/simple/);
  assert.match(sourceConfig.npmrc, /source-gateway:8080\/npm\//);
  assert.match(sourceConfig.aptSources, /source-gateway:8080\/apt/);
  assert.ok(!JSON.stringify(sourceConfig).includes("pypi.org"));
  assert.equal(first.sandbox.id, second.sandbox.id);
  assert.equal(first.sandbox.workerId, second.sandbox.workerId);
  assert.equal(second.sandbox.activeOperations, 2);
  assert.equal(first.nodeSpec.mounts[0].source, second.nodeSpec.mounts[0].source);
  await manager.release(first.operationId);
  const released = await manager.release(second.operationId);
  assert.equal(released.sandbox.activeOperations, 0);
  assert.equal(await manager.release(second.operationId).then((value) => value.released), false);
  assert.deepEqual(await manager.stopIdle(), []);
  now = new Date(now.getTime() + 15 * 60 * 1000 + 1);
  const stopped = await manager.stopIdle();
  assert.equal(stopped[0].stopped, true);
  assert.equal(stopped[0].sandbox.state, "stopped");
  assert.equal(stops.length, 1);
  const restarted = await manager.acquire(OWNER, { image: IMAGE });
  assert.equal(restarted.sandbox.generation, 2);
  assert.equal(starts.length, 2);
  assert.equal(projections.length, 2);
  assert.equal(starts[0].spec.mounts[0].source, starts[1].spec.mounts[0].source);
  assert.deepEqual(audits.map((event) => event.action), ["agent.sandbox_started", "agent.sandbox_idle_stopped", "agent.sandbox_started"]);
});

test("active operations prevent idle stop and running policy drift is rejected", async () => {
  let now = new Date("2026-08-11T05:00:00.000Z");
  const manager = new AgentSandboxManager({
    repository: new MemoryAgentSandboxRepository(),
    policy: policy(),
    clock: () => new Date(now),
    nodeAgent: {
      async startSandbox() { return { nodeId: NODE, containerId: "container-a" }; },
      async projectSandboxFile(input) { return projectionEvidence(input); },
      async stopSandbox() { throw new Error("must not stop active sandbox"); },
    },
  });
  await manager.acquire(OWNER, { image: IMAGE });
  now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  assert.deepEqual(await manager.stopIdle(), []);
  await assert.rejects(
    manager.acquire(OWNER, { image: IMAGE, limits: { pidsLimit: 600 } }),
    { code: "agent_sandbox_runtime_conflict" },
  );
});

test("source policy projection failure removes the new sandbox and leaves a durable error", async () => {
  const repository = new MemoryAgentSandboxRepository();
  const stops = [];
  const manager = new AgentSandboxManager({
    repository,
    policy: policy(),
    clock: () => new Date("2026-08-11T05:00:00.000Z"),
    nodeAgent: {
      async startSandbox() { return { nodeId: NODE, containerId: "container-a" }; },
      async projectSandboxFile() { throw new Error("projection_failed"); },
      async stopSandbox(input) { stops.push(structuredClone(input)); },
    },
  });
  await assert.rejects(manager.acquire(OWNER, { image: IMAGE }), /projection_failed/);
  const failed = await repository.findByOwner(OWNER);
  assert.equal(stops.length, 1);
  assert.equal(failed.state, "error");
  assert.equal(failed.containerId, null);
  assert.equal(failed.lastErrorCode, "node_agent_start_failed");
});
