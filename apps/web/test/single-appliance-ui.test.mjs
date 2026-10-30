import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { test } from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("device administration reads one appliance and exposes no remote provisioning controls", async () => {
  const [client, panel, navigation] = await Promise.all([
    source("../src/device/appliance-client.ts"), source("../src/device/AppliancePanel.tsx"),
    source("../src/authorization/view-policy.mjs"),
  ]);
  assert.match(client, /request\("\/api\/v1\/admin\/appliance"\)/);
  assert.doesNotMatch(client + panel, /admin\/nodes|admin\/fleet|onboarding|sshPassword|node-enrollments|targetNodeIds/);
  assert.match(panel, /dashboard\.appliance/);
  assert.match(navigation, /href: "\/admin\/device"/);
  await assert.rejects(access(new URL("../src/nodes/NodeOnboardingWizard.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../src/nodes/FleetGroupsPanel.tsx", import.meta.url)));
});

test("updates are limited to the local appliance rather than a selected collection", async () => {
  const [client, panel] = await Promise.all([
    source("../src/updates/maintenance-client.ts"), source("../src/updates/MaintenancePanel.tsx"),
  ]);
  assert.match(client, /target_node_ids: \[input\.deviceId\]/);
  assert.match(client, /strategy: "single_node_downtime"/);
  assert.doesNotMatch(client + panel, /rolling|minimumServingNodes|selectedNodeIds|node-picker/);
});
