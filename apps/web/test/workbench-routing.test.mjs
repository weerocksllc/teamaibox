import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adminRoute,
  applicationRoute,
  parseWorkbenchRoute,
  workbenchRoute,
} from "../src/routing/workbench-routing.mjs";

test("maps workbench and administrator deep links to deterministic UI state", () => {
  assert.deepEqual(parseWorkbenchRoute("/"), { surface: "workbench", adminItem: "overview", applicationPluginKey: null });
  assert.deepEqual(parseWorkbenchRoute("/applications"), { surface: "workbench", adminItem: "overview", applicationPluginKey: null });
  assert.deepEqual(parseWorkbenchRoute("/admin"), { surface: "admin", adminItem: "overview", applicationPluginKey: null });
  assert.deepEqual(parseWorkbenchRoute("/admin/device"), { surface: "admin", adminItem: "device", applicationPluginKey: null });
  assert.deepEqual(parseWorkbenchRoute("/admin/nodes"), { surface: "admin", adminItem: "device", applicationPluginKey: null });
  assert.deepEqual(parseWorkbenchRoute("/admin/models"), { surface: "admin", adminItem: "models", applicationPluginKey: null });
  assert.deepEqual(parseWorkbenchRoute("/admin/models/"), { surface: "admin", adminItem: "models", applicationPluginKey: null });
  assert.deepEqual(parseWorkbenchRoute("/apps/asr"), { surface: "workbench", adminItem: "overview", applicationPluginKey: "official.asr" });
  assert.deepEqual(parseWorkbenchRoute("/apps/vendor.tool"), { surface: "workbench", adminItem: "overview", applicationPluginKey: "vendor.tool" });
});

test("fails closed to the default administrator domain for malformed route segments", () => {
  assert.deepEqual(parseWorkbenchRoute("/admin/%2e%2e"), { surface: "admin", adminItem: "overview", applicationPluginKey: null });
  assert.deepEqual(parseWorkbenchRoute("/apps/%2e%2e"), { surface: "workbench", adminItem: "overview", applicationPluginKey: null });
  assert.deepEqual(parseWorkbenchRoute("/apps/asr/private"), { surface: "workbench", adminItem: "overview", applicationPluginKey: null });
  assert.deepEqual(parseWorkbenchRoute("not-a-path"), { surface: "workbench", adminItem: "overview", applicationPluginKey: null });
  assert.equal(adminRoute("../../models"), "/admin");
  assert.equal(applicationRoute("../../asr"), "/");
});

test("builds stable same-origin browser routes", () => {
  assert.equal(workbenchRoute(), "/");
  assert.equal(applicationRoute("official.asr"), "/apps/asr");
  assert.equal(applicationRoute("vendor.tool"), "/apps/vendor.tool");
  assert.equal(adminRoute("overview"), "/admin");
  assert.equal(adminRoute("external-compute"), "/admin/external-compute");
});
