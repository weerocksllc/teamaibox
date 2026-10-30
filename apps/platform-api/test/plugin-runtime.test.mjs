import assert from "node:assert/strict";
import test from "node:test";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginStartupRecovery, ProtectedPluginApplicationRouteSource, ProtectedPluginNodeAgent,
  resolveNodeAgentCertificateFingerprint, createPluginSourceAdaptersFromEnvironment } from "../server/plugin-runtime.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const manifest = Object.freeze({
  id: "example.team-notes",
  type: "ApplicationPlugin",
  version: "1.0.0",
  images: [{ name: "notes", role: "application", variants: [{ architecture: "linux/arm64/v8", reference: "localhost:15000/example/team-notes", digest }] }],
  entryPoints: { web: { path: "/plugins/example.team-notes", integration: "iframe" } },
  resources: { ephemeralStorageBytes: 67_108_864 },
});

function fixtures({ images = manifest.images, health = ["starting", "healthy", "healthy", "healthy"], runtimeNamespace = "test-runtime-a", nodeGeneration = 7, bindingResolver = null, recoveryBindingUpdater = null } = {}) {
  const calls = [];
  let observation = 0;
  const imported = { state: "verified", manifest: { ...manifest, images } };
  const client = {
    async startWorker(input) { calls.push(["start", structuredClone(input)]); },
    async workerHealth(input) {
      calls.push(["health", structuredClone(input)]);
      const current = health[Math.min(observation, health.length - 1)];
      observation += 1;
      if (current instanceof Error) throw current;
      return typeof current === "object" ? { containerId: "container-1", ...current }
        : { status: "running", health: current, containerId: "container-1" };
    },
    async stopWorker(input) { calls.push(["stop", structuredClone(input)]); },
    async fetchApplication(input) { calls.push(["fetch", structuredClone(input)]); return {
      status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from("ready"),
    }; },
  };
  const imports = {
    async get(pluginId, version) { return pluginId === manifest.id && version === manifest.version ? imported : null; },
    async list() { return [{ pluginId: manifest.id, version: manifest.version }]; },
  };
  const sandboxPolicy = { async compile() { return {
    network: { networkName: "plugin-ingress", policyId: "", allowedHosts: [] },
    api: { scopes: ["files:read"] },
    limits: { memoryBytes: 134_217_728, cpuLimitMillicores: 500, pidsLimit: 128, openFilesLimit: 4096 },
    security: { runAsUid: 10001, runAsGid: 10001, readOnlyRoot: true, dropAllCapabilities: true,
      noNewPrivileges: true, privileged: false, hostPid: false, hostIpc: false, hostNetwork: false,
      dockerSocket: false, seccompProfile: "teamaibox-plugin-v1" },
    filesystem: { volumes: [
      { source: "teamaibox-plugin-11111111111111111111111111111111-data", target: "/var/lib/teamaibox/plugin/data", readOnly: false },
      { source: "teamaibox-plugin-11111111111111111111111111111111-cache", target: "/var/cache/teamaibox/plugin", readOnly: false },
    ] },
    devices: [],
  }; } };
  return {
    runtime: new ProtectedPluginNodeAgent({ client, imports, sandboxPolicy, nodeGeneration,
      pollMilliseconds: 0, sleep: async () => {}, applicationIngress: {
        networkName: "plugin-ingress", containerPort: 8080 }, runtimeNamespace, bindingResolver, recoveryBindingUpdater }),
    calls,
    imported, client,
  };
}

const operation = { pluginId: manifest.id, version: manifest.version, slot: "blue", operationKey: "install-runtime-0001" };

test('fresh offline plugin sources do not require a development registry or token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-offline-factory-'));
  try {
    const sources = await createPluginSourceAdaptersFromEnvironment({
      PLATFORM_PLUGIN_SOURCE_MODE: 'offline', PLATFORM_PLUGIN_OFFLINE_BUNDLE_ROOT: root,
    });
    await assert.rejects(sources.sourceRouter.resolve({sourceKind:'marketplace', locator:'example@1.0.0'}),
      {code:'source_unavailable'});
    await assert.rejects(sources.sourceRouter.resolve({sourceKind:'offline-bundle', locator:'not-present'}),
      error => error.code === 'source_unavailable' || error.code === 'source_not_found');
    sources.close();
    await assert.rejects(createPluginSourceAdaptersFromEnvironment({PLATFORM_PLUGIN_SOURCE_MODE:'typo'}), /mode is invalid/);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('offline image plugins use the exact local content ID without constructing a registry reference', async () => {
  const images = structuredClone(manifest.images);
  images[0].variants[0].reference = digest;
  const setup = fixtures({images});
  await setup.runtime.start(operation);
  assert.equal(setup.calls.find(([kind]) => kind === 'start')[1].worker.image, digest);
  setup.imported.manifest.images[0].variants[0].reference = 'sha256:' + 'b'.repeat(64);
  await assert.rejects(setup.runtime.start(operation), /differs from manifest/);
});

test("missing retained app is rebound only after removal and starts with current authority", async () => {
  let generation = 5;
  const setup = fixtures({ health: [Object.assign(new Error('missing'), {code:'managed_worker_not_found'}), 'healthy'],
    bindingResolver: async () => generation,
    recoveryBindingUpdater: async input => {
      assert.equal(input.previousGeneration,5);
      assert.deepEqual(setup.calls.map(([kind]) => kind),['health','stop']);
      generation = 8;
    } });
  const result = await setup.runtime.recoverApplication(operation);
  assert.equal(result.runtimeGeneration,8);
  assert.equal(setup.calls.find(([kind]) => kind === 'stop')[1].authority.nodeGeneration,5);
  assert.equal(setup.calls.find(([kind]) => kind === 'start')[1].authority.nodeGeneration,8);
  assert.notEqual(setup.calls[0][1].workerId,setup.calls.find(([kind]) => kind === 'start')[1].worker.workerId);
});

test("healthy retained apps are not rebound and failed removal cannot change their binding", async () => {
  const update = async () => assert.fail('must not rebind');
  const healthy = fixtures({health:['healthy'],recoveryBindingUpdater:update});
  await healthy.runtime.recoverApplication(operation);
  const denied = fixtures({health:[{status:'exited',health:'stopped'}],recoveryBindingUpdater:update});
  denied.client.stopWorker = async () => {throw new Error('ownership denied');};
  await assert.rejects(denied.runtime.recoverApplication(operation),/ownership denied/);
  assert.ok(!denied.calls.some(([kind]) => kind === 'start'));
});

test("boot recovery keeps healthy application running without stop/start", async () => {
  const setup = fixtures({ health: ["healthy"] });
  assert.equal((await setup.runtime.recoverApplication(operation)).restarted, false);
  assert.ok(setup.calls.every(([kind]) => kind === "health"));
});
test("boot recovery replaces only stopped owned app runtime and retains volume names", async () => {
  const setup = fixtures({ health: [{status: "exited", health: "stopped"}, "healthy"] });
  assert.equal((await setup.runtime.recoverApplication(operation)).restarted, true);
  assert.deepEqual(setup.calls.slice(0, 3).map(([kind]) => kind), ["health", "stop", "start"]);
  assert.equal(setup.calls[1][1].authority.nodeGeneration, 7);
  assert.equal(setup.calls[2][1].worker.mounts.length, 2);
});
test("missing app can recover but transport, fencing and ownership failures cannot mutate", async () => {
  const missing = Object.assign(new Error("missing"), {code: "managed_worker_not_found"});
  const setup = fixtures({ health: [missing, "healthy"] });
  assert.equal((await setup.runtime.recoverApplication(operation)).healthy, true);
  for (const code of ["worker_health_failed", "node_agent_transport_unavailable", "stale_node_generation", "node_agent_protocol_mismatch"]) {
    const bad = fixtures({ health: [Object.assign(new Error(code), {code})] });
    await assert.rejects(bad.runtime.recoverApplication(operation));
    assert.deepEqual(bad.calls.map(([kind]) => kind), ["health"]);
  }
  const ownership = fixtures({health: [missing]});
  ownership.client.stopWorker = async () => { throw new Error("ownership denied"); };
  await assert.rejects(ownership.runtime.recoverApplication(operation), /ownership denied/);
  assert.ok(!ownership.calls.some(([kind]) => kind === "start"));
});
test("boot recovery refuses unverified or compute manifests", async () => {
  for (const change of [{state: "rejected"}, {manifest: {...manifest, type: "ComputePlugin"}}]) {
    const setup = fixtures(); Object.assign(setup.imported, change);
    await assert.rejects(setup.runtime.recoverApplication(operation));
    assert.equal(setup.calls.length, 0);
  }
});
test("plugin worker identities differ across node generation without relabeling old containers", async () => {
  const old = fixtures({nodeGeneration: 3}), current = fixtures({nodeGeneration: 4});
  await old.runtime.start(operation); await current.runtime.start(operation);
  assert.notEqual(old.calls[0][1].worker.workerId, current.calls[0][1].worker.workerId);
});
test("boot recovery survives a 24-minute dependency delay, keeps successes and backs off", async () => {
  let clock = 0, attempts = 0, completedSet; const audits = [], sleeps = [];
  const recovery = new PluginStartupRecovery({ clock: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    lifecycleService: {async recoverEnabledApplications({completed,canContinue}) {
      attempts++; assert.equal(canContinue(), true);
      if (!completedSet) { completedSet = completed; completed.add("already-healthy"); }
      assert.equal(completed, completedSet); assert.equal(completed.has("already-healthy"), true);
      if (clock < 60_000) throw new Error("database not listening");
      return {pending: clock < 24 * 60_000 ? 1 : 0};
    }}, audit: async e => audits.push(e) });
  await recovery.run();
  assert.ok(clock >= 24 * 60_000); assert.ok(attempts < 35);
  assert.deepEqual(sleeps.slice(0, 5), [5_000, 10_000, 20_000, 40_000, 60_000]);
  assert.ok(sleeps.every(ms => ms <= 60_000));
  assert.deepEqual(audits.map(e => e.action), ["plugin.boot_recovery_waiting", "plugin.boot_recovery_completed"]);
  const finishedAttempts = attempts;
  recovery.start(); await recovery.run(); assert.equal(attempts, finishedAttempts);
});

test("boot recovery is single-flight and close cancels its dependency wait", async () => {
  let attempts = 0, canContinue, signal;
  let waiting; const sleepStarted = new Promise(resolve => { waiting = resolve; });
  const recovery = new PluginStartupRecovery({
    lifecycleService: {async recoverEnabledApplications(input) { attempts++; canContinue = input.canContinue; return {pending: 1}; }},
    sleep: (ms, abort) => new Promise((resolve, reject) => {
      signal = abort; abort.addEventListener("abort", () => reject(new Error("aborted")), {once: true}); waiting();
    }) });
  const first = recovery.run(); recovery.start(); assert.equal(recovery.run(), first);
  await sleepStarted; recovery.close(); await first;
  assert.equal(signal.aborted, true); assert.equal(canContinue(), false); assert.equal(attempts, 1);
  await recovery.run(); assert.equal(attempts, 1);
});

test("boot recovery tolerates audit outage and never runs after closing", async () => {
  let clock = 0, attempts = 0;
  const recovery = new PluginStartupRecovery({clock: () => clock, sleep: async ms => { clock += ms; },
    lifecycleService: {async recoverEnabledApplications() { attempts++; return {pending: clock < 600_000 ? 1 : 0}; }},
    audit: async () => { throw new Error("audit unavailable"); } });
  await recovery.run(); assert.ok(clock >= 600_000);
  const closed = new PluginStartupRecovery({lifecycleService: {recoverEnabledApplications() { assert.fail("closed"); }}});
  closed.close(); await closed.run();
});

test("plugin runtime reads the deployment-local Node Agent fingerprint and fails closed on drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-plugin-fingerprint-"));
  const path = join(directory, "fingerprint");
  const localFingerprint = `sha256:${"b".repeat(64)}`;
  try {
    await writeFile(path, `${localFingerprint}\n`, { mode: 0o600 });
    assert.equal(await resolveNodeAgentCertificateFingerprint({ path }), localFingerprint);
    await writeFile(path, `${localFingerprint.slice(7)}\n`, { mode: 0o600 });
    assert.equal(await resolveNodeAgentCertificateFingerprint({ path }), localFingerprint);
    await assert.rejects(resolveNodeAgentCertificateFingerprint({ configured: digest, path }),
      /fingerprint sources differ/);
    await writeFile(path, "not-a-fingerprint\n", { mode: 0o600 });
    await assert.rejects(resolveNodeAgentCertificateFingerprint({ path }), /fingerprint file is invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("production plugin runtime sends an exact-digest, non-model, sandboxed Node Agent worker", async () => {
  const setup = fixtures();
  await setup.runtime.stage(operation);
  await setup.runtime.start(operation);
  const request = setup.calls.find(([kind]) => kind === "start")[1];
  assert.equal(request.worker.workloadKind, "application-plugin");
  assert.equal(request.worker.pluginId, manifest.id);
  assert.equal(request.worker.attemptId, "");
  assert.equal(request.worker.modelProfileId, "");
  assert.equal(request.worker.image, `localhost:15000/example/team-notes@${digest}`);
  assert.equal(request.worker.network, "plugin-ingress");
  assert.deepEqual(request.worker.publishedPorts, []);
  assert.equal(request.worker.applicationPort, 8080);
  assert.equal(request.worker.security.seccompProfile, "teamaibox-plugin-v1");
  assert.equal(request.worker.mounts.length, 2);
  assert.deepEqual(request.worker.devices, []);
});

test("production plugin runtime does not count Docker starting as a healthy observation", async () => {
  const setup = fixtures();
  const health = await setup.runtime.waitHealthy({ ...operation, requiredConsecutive: 3 });
  assert.equal(health.healthy, true);
  assert.equal(health.consecutive, 3);
  assert.equal(health.observations, 4);
  assert.equal(health.containerId, "container-1");
  assert.deepEqual(health.access, { pathPrefix: "/plugins/example.team-notes", integration: "iframe", transport: "node-agent-mtls-proxy" });
});

test("production plugin runtime resolves only a live same-worker application route", async () => {
  const setup = fixtures({ health: ["healthy"] });
  const route = await setup.runtime.resolveApplicationRoute(operation);
  assert.deepEqual({ ...route, observedAt: "[observed]" }, {
    pluginKey: "example.team-notes", pathPrefix: "/plugins/example.team-notes", integration: "iframe",
    healthy: true, transport: "node-agent-mtls-proxy", observedAt: "[observed]",
  });
  assert.equal(Number.isFinite(new Date(route.observedAt).getTime()), true);
});

test("production plugin runtime fetches application content only through the fenced mTLS Node Agent", async () => {
  const setup = fixtures({ health: ["healthy"] });
  const result = await setup.runtime.fetchApplication({ ...operation, method: "GET", path: "/plugins/example.team-notes?theme=dark" });
  assert.equal(result.body.toString(), "ready");
  const fetch = setup.calls.find(([kind]) => kind === "fetch")[1];
  assert.equal(fetch.path, "/plugins/example.team-notes?theme=dark");
  assert.equal(fetch.method, "GET");
  await assert.rejects(setup.runtime.fetchApplication({ ...operation, method: "GET", path: "/plugins/other" }),
    (error) => error.code === "plugin_application_path_denied");
});

test("dynamic route source exposes only enabled healthy applications and delegates content to the same active slot", async () => {
  const calls = [];
  const source = new ProtectedPluginApplicationRouteSource({
    repository: { async listPlugins() { return [
      { pluginId: "example.team-notes", pluginType: "ApplicationPlugin", lifecycleState: "enabled", currentVersion: "2.0.0", activeSlot: "green", generation: 9 },
      { pluginId: "example.disabled", pluginType: "ApplicationPlugin", lifecycleState: "disabled", currentVersion: "1.0.0", activeSlot: "blue", generation: 2 },
      { pluginId: "example.compute", pluginType: "ComputePlugin", lifecycleState: "enabled", currentVersion: "1.0.0", activeSlot: "blue", generation: 3 },
    ]; } },
    nodeAgent: {
      async resolveApplicationRoute(input) { calls.push(["route", input]); return { pluginKey: input.pluginId, pathPrefix: `/plugins/${input.pluginId}`, integration: "iframe", transport: "node-agent-mtls-proxy", healthy: true, observedAt: new Date().toISOString() }; },
      async fetchApplication(input) { calls.push(["fetch", input]); return { status: 200, headers: {}, body: Buffer.from("v2") }; },
    },
  });
  assert.deepEqual((await source.routes()).map((item) => item.pluginKey), ["example.team-notes"]);
  const routeCalls = calls.length;
  assert.deepEqual(await source.routes({ pluginKey: "example.absent" }), []);
  assert.equal(calls.length, routeCalls, "targeted requests must not probe other plugins");
  const content = await source.fetch({ pluginKey: "example.team-notes", method: "GET", path: "/plugins/example.team-notes" });
  assert.equal(content.body.toString(), "v2");
  assert.equal(calls.at(-1)[1].slot, "green");
  assert.equal(await source.fetch({ pluginKey: "example.disabled", method: "GET", path: "/plugins/example.disabled" }), null);
});

test("current application reads use the lightweight projection, not all historical plugin details", async () => {
  const calls = [], key = "example.notes";
  const source = new ProtectedPluginApplicationRouteSource({ repository: {
    async listPlugins() { assert.fail("historical inventory is not needed for asset reads"); },
    async listRuntimePlugins(input) { calls.push(input); return [{ pluginId: key, pluginType: "ApplicationPlugin",
      lifecycleState: "enabled", currentVersion: "1.0.0", activeSlot: "blue", generation: 1 }]; },
  }, nodeAgent: {
    async resolveApplicationRoute() { return { pluginKey: key }; },
    async fetchApplication(input) { assert.equal(input.pluginId, key); return { status: 200 }; },
  } });
  await source.routes({ pluginKey: key }); await source.fetch({ pluginKey: key, method: "GET", path: `/plugins/${key}/app.js` });
  assert.deepEqual(calls, [{ pluginKey: key }, { pluginKey: key }]);
});

test("production plugin runtime tolerates the bounded Docker ARM64 initial health delay", async () => {
  const setup = fixtures({ health: ["starting", "starting", "starting", "starting", "starting", "starting", "healthy", "healthy", "healthy"] });
  const health = await setup.runtime.waitHealthy({ ...operation, probes: {
    startup: { intervalSeconds: 5, failureThreshold: 12 },
    readiness: { intervalSeconds: 10, failureThreshold: 3 },
  }, requiredConsecutive: 3 });
  assert.equal(health.healthy, true);
  assert.equal(health.observations, 9);
});

test("production plugin runtime stops waiting when Docker reaches a terminal unhealthy state", async () => {
  const setup = fixtures({ health: ["starting", "starting", "unhealthy", "healthy", "healthy", "healthy"] });
  const health = await setup.runtime.waitHealthy({ ...operation, requiredConsecutive: 3 });
  assert.equal(health.healthy, false);
  assert.equal(health.runtimeHealth, "unhealthy");
  assert.equal(health.observations, 3);
  assert.equal(setup.calls.filter(([kind]) => kind === "health").length, 3);
});

test("production plugin runtime stops waiting when the plugin container exits", async () => {
  const setup = fixtures({ health: [{ status: "exited", health: "unhealthy" }] });
  const health = await setup.runtime.waitHealthy({ ...operation, requiredConsecutive: 3 });
  assert.equal(health.healthy, false);
  assert.equal(health.runtimeStatus, "exited");
  assert.equal(health.observations, 1);
});

test("production plugin runtime fails closed on an unsupported signed image topology", async () => {
  const setup = fixtures({ images: [...manifest.images, ...manifest.images] });
  await assert.rejects(setup.runtime.stage(operation), (error) => error.code === "plugin_runtime_image_topology_unsupported");
  assert.equal(setup.calls.length, 0);
});

test("production plugin runtime permits signed migration images but starts only the one application image", async () => {
  const migration = { name: "schema-migration", role: "migration", variants: [{ architecture: "linux/arm64/v8",
    reference: "localhost:15000/example/team-notes-migration", digest }] };
  const setup = fixtures({ images: [...manifest.images, migration] });
  await setup.runtime.stage(operation);
  await setup.runtime.start(operation);
  const request = setup.calls.find(([kind]) => kind === "start")[1];
  assert.equal(request.worker.image, `localhost:15000/example/team-notes@${digest}`);
  assert.equal(request.worker.workloadKind, "application-plugin");
});

test("production plugin runtime stop reuses deterministic fenced ownership", async () => {
  const setup = fixtures();
  await setup.runtime.start(operation);
  await setup.runtime.stop(operation);
  const start = setup.calls.find(([kind]) => kind === "start")[1];
  const stop = setup.calls.find(([kind]) => kind === "stop")[1];
  assert.equal(stop.workerId, start.worker.workerId);
  assert.deepEqual(stop.authority, start.authority);
});

test("independent platform deployments receive disjoint deterministic worker ownership", async () => {
  const left = fixtures({ runtimeNamespace: "candidate-a" });
  const right = fixtures({ runtimeNamespace: "candidate-b" });
  await left.runtime.start(operation);
  await right.runtime.start(operation);
  const leftStart = left.calls.find(([kind]) => kind === "start")[1];
  const rightStart = right.calls.find(([kind]) => kind === "start")[1];
  assert.notEqual(leftStart.worker.workerId, rightStart.worker.workerId);
  assert.notEqual(leftStart.authority.leaseId, rightStart.authority.leaseId);
});
