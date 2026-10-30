import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("administrator navigation has one sidebar source without duplicate domain cards", async () => {
  const app = await source("App.tsx");
  assert.match(app, /<h2>\{t\("admin\.navigation"\)\}<\/h2>/);
  assert.match(app, /const active = surface === "admin" && activeAdminItem === item\.id/);
  assert.doesNotMatch(app, /t\("nav\.admin"\)/);
  assert.doesNotMatch(app, /admin-domain-(?:grid|card|detail)/);
});

test("administrator overview renders live operations data with truthful failure handling", async () => {
  const [overview, nodes] = await Promise.all([
    source("overview/AdminOverviewPanel.tsx"),
    source("device/AppliancePanel.tsx"),
  ]);
  assert.match(overview, /loadApplianceDashboard\(\)/);
  assert.match(overview, /<OperationsOverview dashboard=\{dashboard\} t=\{t\} \/>/);
  assert.match(overview, /document\.visibilityState === "visible"/);
  assert.match(overview, /role="alert"/);
  assert.match(nodes, /export function OperationsOverview/);
  assert.match(nodes, /domains\.cpu\?\.utilizationPercent/);
  assert.match(nodes, /domains\.unifiedMemory\?\.usedBytes/);
  assert.match(nodes, /dashboard\.alerts\.length/);
});
