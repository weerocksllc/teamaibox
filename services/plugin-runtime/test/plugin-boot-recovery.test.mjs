import assert from "node:assert/strict";
import test from "node:test";
import { PluginLifecycleService } from "../src/plugin-lifecycle-service.mjs";

function setup(rows) {
  const calls = [], audits = [];
  const repository = {
    async listPlugins() { return rows; },
    async getPlugin(id) {return rows.find(row => row.pluginId === id);},
    async runExclusive(id, fn) {calls.push(["lock", id]); return fn();},
  };
  const service = new PluginLifecycleService({ repository, verifiedImports: {get(){}}, migrationRunner: {},
    sandboxPolicy: {compile(){}}, nodeAgent: {async recoverApplication(input) {calls.push(["recover", input]);return {healthy:true,restarted:true};}},
    audit: async e => audits.push(e) });
  return {service, repository, calls, audits};
}
const app = {pluginId:"test.notes",pluginType:"ApplicationPlugin",currentVersion:"1.0.0",activeSlot:"blue",generation:1,lifecycleState:"enabled"};
test("boot pass restores enabled applications only, without changing lifecycle or repeating successes", async () => {
  const rows = [app,{...app,pluginId:"disabled",lifecycleState:"disabled"}, {...app,pluginId:"compute",pluginType:"ComputePlugin"},
    {...app,pluginId:"removed",lifecycleState:"uninstalled"}];
  const original = structuredClone(rows), s = setup(rows), completed = new Set();
  const args = {operationKey:"boot-recovery-0001",completed};
  assert.deepEqual(await s.service.recoverEnabledApplications(args),{pending:0});
  await s.service.recoverEnabledApplications(args);
  assert.equal(s.calls.filter(([kind]) => kind === "recover").length,1);
  assert.equal(s.audits.length,1); assert.deepEqual(rows,original);
});
test("disable winning the lifecycle lock prevents recovery", async () => {
  const s = setup([{...app}]);
  s.repository.getPlugin = async () => ({...app,lifecycleState:"disabled"});
  await s.service.recoverEnabledApplications({operationKey:"boot-recovery-0002"});
  assert.equal(s.calls.filter(([kind]) => kind === "recover").length,0);
});
test("seeded built-in pages without an imported image are not recreated as plugins", async () => {
  const s = setup([{...app,protectedOfficial:true}]);
  assert.deepEqual(await s.service.recoverEnabledApplications({operationKey:"boot-recovery-0003"}),{pending:0});
  assert.equal(s.calls.filter(([kind]) => kind === "recover").length,0);
});
