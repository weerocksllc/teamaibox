import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { HostMaintenancePolicy } from "../src/host/host-maintenance-policy.mjs";

const POLICY = JSON.parse(await readFile(new URL("../../../deploy/host/maintenance-policy.v1.json", import.meta.url), "utf8"));
const ADMIN = { identityId: "018f6f18-24d7-7c21-9b62-8c017419958b", principalKind: "administrator", permissions: ["update:manage"] };

test("host OS driver kernel and firmware plans require a separate administrator-only channel", () => {
  const policy = new HostMaintenancePolicy({ policy: POLICY });
  const plan = policy.authorizePlan({ context: ADMIN, workloadKind: "host-maintenance", sourceKey: "nvidia-compute", categories: ["nvidia-driver", "kernel"], packages: ["nvidia-driver-580=580.159.03", "linux-nvidia"], recoveryEvidenceRef: "evidence://host/recovery/2026-08" });
  assert.equal(plan.target, "appliance-host");
  assert.equal(plan.executor, "node-agent-host-maintenance");
  assert.match(plan.planSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(plan).includes("source-gateway:8080/apt"), false);
});

test("Agent and plugin callers cannot turn sandbox APT into host maintenance", () => {
  const policy = new HostMaintenancePolicy({ policy: POLICY });
  const base = { context: ADMIN, workloadKind: "agent-sandbox", sourceKey: "ubuntu-base", categories: ["kernel"], packages: ["linux-nvidia"], recoveryEvidenceRef: "evidence://host/recovery/one" };
  assert.throws(() => policy.authorizePlan(base), { code: "host_maintenance_channel_required" });
  assert.throws(() => policy.authorizePlan({ ...base, workloadKind: "host-maintenance", context: { ...ADMIN, principalKind: "user" } }), { code: "host_maintenance_permission_required" });
  assert.throws(() => policy.authorizePlan({ ...base, workloadKind: "host-maintenance", sourceKey: "sandbox-apt" }), { code: "host_maintenance_source_denied" });
});
