import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PluginSandboxError, PluginSandboxPolicy } from "../src/sandbox-policy.mjs";

const policy = JSON.parse(await readFile(new URL("../../../deploy/plugins/sandbox-policy.v1.json", import.meta.url), "utf8"));

function manifest(type = "ApplicationPlugin") {
  const application = type === "ApplicationPlugin";
  return {
    id: application ? "example.team-notes" : "example.fast-ocr",
    type,
    permissions: {
      platformApiScopes: application ? ["files:write", "files:read"] : ["compute:report"],
      delegatedUserToken: application,
      network: application
        ? { mode: "none", egressHosts: [] }
        : { mode: "allowlist", egressHosts: ["models.example.test", "api.example.test"] },
      objectNamespaces: application ? ["notes.data"] : ["ocr.artifacts"],
      devices: application ? [] : ["accelerator", "video-codec"],
    },
    resources: {
      cpu: { requestMillicores: 250, limitMillicores: application ? 1000 : 4000 },
      unifiedMemoryBytes: application ? 134217728 : 8589934592,
      ephemeralStorageBytes: 67108864,
      persistentStorageBytes: application ? 1073741824 : 0,
      network: { ingressBitsPerSecond: 100000000, egressBitsPerSecond: 100000000 },
      ...(!application ? { accelerator: { kind: "nvidia-gpu", units: 1 } } : {}),
    },
  };
}

function fixture({ auditFailure = false } = {}) {
  const audit = [];
  return {
    audit,
    sandbox: new PluginSandboxPolicy({
      policy: structuredClone(policy),
      auditSink: {
        async record(event) {
          if (auditFailure) throw new Error("audit unavailable");
          audit.push(event);
        },
      },
      clock: () => new Date("2026-08-11T00:00:00.000Z"),
    }),
  };
}

test("ApplicationPlugin compiles to a non-root read-only namespace with isolated ingress and no egress, host mount, socket, or device", async () => {
  const { sandbox } = fixture();
  const result = await sandbox.compile({
    manifest: manifest(),
    version: "1.2.3",
    operationKey: "install-sandbox-001",
  });
  assert.deepEqual(result.security, {
    runAsUid: 10001,
    runAsGid: 10001,
    readOnlyRoot: true,
    dropAllCapabilities: true,
    noNewPrivileges: true,
    privileged: false,
    hostPid: false,
    hostIpc: false,
    hostNetwork: false,
    dockerSocket: false,
    seccompProfile: "teamaibox-plugin-v1",
  });
  assert.equal(result.network.networkName, "plugin-ingress");
  assert.equal(result.network.mode, "none");
  assert.deepEqual(result.network.allowedHosts, []);
  assert.deepEqual(result.devices, []);
  assert.deepEqual(result.filesystem.hostMounts, []);
  assert.deepEqual(result.filesystem.volumes.map((item) => item.target), [
    "/var/lib/teamaibox/plugin/data",
    "/var/cache/teamaibox/plugin",
  ]);
  assert.ok(result.filesystem.volumes.every((item) => /^teamaibox-plugin-[a-f0-9]{32}-(data|cache)$/.test(item.source)));
  assert.deepEqual(result.api.scopes, ["files:read", "files:write"]);
  assert.equal(result.api.credentialMode, "request-bound-delegated-user");
  assert.equal(result.api.permanentCredentials, false);
});

test("ComputePlugin receives only declared scheduler scopes, proxy destinations, and mapped NVIDIA device classes", async () => {
  const { sandbox } = fixture();
  const result = await sandbox.compile({ manifest: manifest("ComputePlugin"), version: "1.0.0" });
  assert.equal(result.network.networkName, "plugin-egress-proxy");
  assert.equal(result.network.egressProxyOnly, true);
  assert.deepEqual(result.network.allowedHosts, ["api.example.test", "models.example.test"]);
  assert.deepEqual(result.devices, ["nvidia.com/gpu=all", "nvidia.com/nvdec=all", "nvidia.com/nvenc=all"]);
  assert.deepEqual(result.api.scopes, ["compute:report"]);
  assert.equal(result.api.credentialMode, "projected-scheduler-file");
  assert.equal(JSON.stringify(result).toLowerCase().includes("vram"), false);
});

test("root, privileged, host namespace/network, Docker socket, and undeclared host mounts are denied and audited", async () => {
  const { sandbox, audit } = fixture();
  await assert.rejects(
    sandbox.compile({
      manifest: manifest(),
      version: "1.2.3",
      operationKey: "install-sandbox-002",
      requested: {
        runAsUid: 0,
        privileged: true,
        hostPid: true,
        network: "host",
        dockerSocket: true,
        mounts: [{ type: "bind", source: "/var/run/docker.sock", target: "/run/socket" }],
      },
    }),
    (error) => error instanceof PluginSandboxError
      && error.reasonCodes.includes("root_user_forbidden")
      && error.reasonCodes.includes("docker_socket_forbidden")
      && error.reasonCodes.includes("host_network_forbidden"),
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "plugin.sandbox.denied");
  assert.equal(JSON.stringify(audit[0]).includes("/var/run/docker.sock"), false);
  assert.equal(JSON.stringify(audit[0]).includes("/run/socket"), false);
  assert.deepEqual(audit[0].reasonCodes, [...audit[0].reasonCodes].sort());
});

test("undeclared API scopes, devices, and network destinations fail before Node Agent staging", async () => {
  const { sandbox, audit } = fixture();
  await assert.rejects(
    sandbox.compile({
      manifest: manifest(),
      requested: {
        apiScopes: ["admin:root"],
        devices: ["nvidia.com/gpu=all"],
        egressHosts: ["private.example.test"],
      },
    }),
    (error) => error.reasonCodes.includes("undeclared_api_scope")
      && error.reasonCodes.includes("undeclared_device")
      && error.reasonCodes.includes("undeclared_network_destination"),
  );
  assert.equal(audit.length, 1);
});

test("forbidden metadata, loopback, wildcard, and unmapped direct-audio access fail closed", async () => {
  const hosts = manifest("ComputePlugin");
  hosts.permissions.network.egressHosts = ["169.254.169.254", "*.example.test"];
  await assert.rejects(
    fixture().sandbox.compile({ manifest: hosts }),
    (error) => error.reasonCodes.includes("network_destination_forbidden"),
  );
  const audio = manifest("ComputePlugin");
  audio.permissions.devices = ["audio"];
  await assert.rejects(
    fixture().sandbox.compile({ manifest: audio }),
    (error) => error.reasonCodes.includes("device_forbidden"),
  );
});

test("filesystem and network policy identities are deterministic per plugin and distinct across plugins", async () => {
  const { sandbox } = fixture();
  const first = await sandbox.compile({ manifest: manifest(), version: "1.0.0" });
  const repeat = await sandbox.compile({ manifest: manifest(), version: "2.0.0" });
  const otherManifest = manifest();
  otherManifest.id = "example.team-calendar";
  const other = await sandbox.compile({ manifest: otherManifest, version: "1.0.0" });
  assert.equal(first.filesystem.volumes[0].source, repeat.filesystem.volumes[0].source);
  assert.notEqual(first.filesystem.volumes[0].source, other.filesystem.volumes[0].source);
  const compute = manifest("ComputePlugin");
  const computeOther = manifest("ComputePlugin");
  computeOther.id = "example.second-ocr";
  assert.notEqual(
    (await sandbox.compile({ manifest: compute })).network.policyId,
    (await sandbox.compile({ manifest: computeOther })).network.policyId,
  );
});

test("audit transport failure never turns a sandbox denial into an allow", async () => {
  const { sandbox } = fixture({ auditFailure: true });
  await assert.rejects(
    sandbox.compile({ manifest: manifest(), requested: { dockerSocket: true } }),
    (error) => error.code === "plugin_sandbox_denied",
  );
});
