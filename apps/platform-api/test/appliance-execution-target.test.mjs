import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireLocalApplianceExecutionTarget } from '../server/appliance-execution-target.mjs';
import { createPluginRuntimeFromEnvironment } from '../server/plugin-runtime.mjs';

const local = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const environment = { PLATFORM_APPLIANCE_NODE_ID: local };

test('installed plugin targets can only use the local executor', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    requireLocalApplianceExecutionTarget(environment, { nodeId: local, host, port: 9443 });
  }
  for (const patch of [{nodeId: other}, {host: '10.64.0.19'}, {host: 'executor.example'},
    {host: '0.0.0.0'}, {port: 443}, {port: 9444}, {nodeId: undefined}]) {
    assert.throws(() => requireLocalApplianceExecutionTarget(environment,
      {nodeId: local, host: '127.0.0.1', port: 9443, ...patch}), /this appliance/);
  }
  assert.throws(() => requireLocalApplianceExecutionTarget({}, {nodeId: local, host: '127.0.0.1', port: 9443}), /this appliance/);
  requireLocalApplianceExecutionTarget({...environment, PLATFORM_APPLIANCE_AGENT_PORT: '19443'},
    {nodeId: local, host: '127.0.0.1', port: 19443});
});

test('the plugin runtime factory reject a foreign executor before secrets or database access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teamaibox-local-executor-'));
  try {
    const path = join(directory, 'runtime.json');
    await writeFile(path, JSON.stringify({schemaVersion: 1, node: {nodeId: other, host: '127.0.0.1', port: 9443}}));
    const database = {query() {assert.fail('must not query');}, transaction() {assert.fail('must not transact');}};
    for (const [factory, key] of [[createPluginRuntimeFromEnvironment, 'PLATFORM_PLUGIN_RUNTIME_CONFIG_FILE']]) {
      await assert.rejects(factory({...environment, [key]: path}, {database}), /this appliance/);
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});
