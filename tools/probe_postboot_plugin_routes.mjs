// Read-only route diagnosis; no recovery, deployment, credentials or guest data.
import { createPostgresDatabaseFromEnvironment } from '/opt/teamaibox/packages/persistence/src/postgres-database.mjs';
import { createPluginRuntimeFromEnvironment, ProtectedPluginNodeAgent } from '/opt/teamaibox/apps/platform-api/server/plugin-runtime.mjs';
const database = await createPostgresDatabaseFromEnvironment(process.env);
const original = ProtectedPluginNodeAgent.prototype.resolveApplicationRoute;
const observations = [];
ProtectedPluginNodeAgent.prototype.resolveApplicationRoute = async function (input) {
  try {
    const result = await original.call(this, input);
    observations.push({ pluginId: input.pluginId, available: result !== null });
    return result;
  } catch (error) {
    observations.push({ pluginId: input.pluginId, available: false,
      errorCode: /^[a-z][a-z0-9_]{2,100}$/.test(error?.code ?? '') ? error.code : null,
      errorType: error?.constructor?.name ?? 'Error',
      message: String(error?.message ?? '').replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 160) });
    throw error;
  }
};
let runtime;
try {
  runtime = await createPluginRuntimeFromEnvironment(process.env, { database,
    audit: async event => observations.push({ policyAction: event.action, outcome: event.outcome }) });
  await runtime.applicationRouteSource.routes({ pluginKey: 'official.virtual-phones' });
  console.log(JSON.stringify({ readOnly: true, observations }));
} finally {
  ProtectedPluginNodeAgent.prototype.resolveApplicationRoute = original;
  runtime?.close();
  await database.close();
}
