import { readFile } from 'node:fs/promises';
import { nativeRequestTarget } from './opencode-native-transport.mjs';
import { nativeInstanceBusy } from './opencode-native-activity.mjs';
import { penpotRuntimePaths as paths } from './penpot-runtime-config.mjs';

const owned = value => value?.type === 'remote' && value.url === paths.endpoint
  && value.oauth === false && !value.headers;

// Use native per-directory MCP.add, never config PATCH / instance.dispose.
// Adding this one entry does not restart an engine, cancel a prompt, rewrite
// user configuration or touch the native session database.
export function createPenpotNativeActivation({ transport, context = async () => {
  try { return JSON.parse(await readFile(paths.context, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}, clock = Date.now, intervalMs = 5000, onUnavailable = () => {} }) {
  const pending = new Map(), checked = new Map();
  async function reconcile(directory) {
    const setting = await context();
    if (setting === null) return {status: 'unconfigured'};
    if (setting.schemaVersion !== 1 || typeof setting.enabled !== 'boolean') throw Error('invalid_context');
    const suffix = '?directory=' + encodeURIComponent(directory);
    const scoped = {request: (method, path, options) => transport.request(method, path + suffix, options)};
    const get = async path => {
      const response = await scoped.request('GET', path, {signal: AbortSignal.timeout(5000)});
      if (!response.ok) { await response.body?.cancel(); throw Error('native_unavailable'); }
      return response.json();
    };
    const config = await get('/config');
    const entry = config.mcp?.[paths.entry];
    if (entry && !owned(entry)) return {status: 'configuration_conflict'};
    if (setting.enabled && !config.plugin?.includes(paths.plugin)) return {status: 'restart_required'};
    const state = (await get('/mcp'))[paths.entry]?.status;
    if ((setting.enabled && state === 'connected') || (!setting.enabled && (!state || state === 'disabled'))) {
      return {status: setting.enabled ? 'ready' : 'disabled'};
    }
    // Only a new connection waits for idle. An already connected MCP must
    // remain ready while its own model task or a user's terminal is active.
    // Revocation never waits for a model/terminal.
    if (setting.enabled && await nativeInstanceBusy(scoped)) return {status: 'waiting_for_idle'};
    // Recheck operator intent after native queries, before changing the entry.
    const latest = await context();
    if (JSON.stringify(latest) !== JSON.stringify(setting)) return {status: 'configuration_changed'};
    const response = await scoped.request('POST', '/mcp', {
      body: JSON.stringify({name: paths.entry, config: {type: 'remote', url: paths.endpoint,
        enabled: setting.enabled, oauth: false}}), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error('native_unavailable'); }
    const result = await response.json();
    return {status: result[paths.entry]?.status === 'connected' ? 'ready'
      : !setting.enabled && result[paths.entry]?.status === 'disabled' ? 'disabled' : 'unavailable'};
  }
  return {
    refresh(method, target) {
      const {directory} = nativeRequestTarget(method, target);
      if (pending.has(directory)) return pending.get(directory);
      const previous = checked.get(directory);
      if (previous && clock() - previous.at < intervalMs) return Promise.resolve(previous.value);
      const work = reconcile(directory).catch(() => {
        onUnavailable('penpot_native_activation_unavailable'); return {status: 'unavailable'};
      }).then(value => {
        checked.set(directory, {at: clock(), value});
        if (checked.size > 256) checked.delete(checked.keys().next().value);
        return value;
      }).finally(() => pending.delete(directory));
      pending.set(directory, work); return work;
    },
  };
}
