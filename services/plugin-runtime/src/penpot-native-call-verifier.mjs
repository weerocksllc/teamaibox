import { PlatformError } from '../../../packages/observability/src/index.mjs';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const denied = () => { throw new PlatformError('penpot_call_denied',
  'The current design call is not authorized', { status: 403 }); };

async function boundedJson(response) {
  if (!response.ok || !response.body) { await response.body?.cancel(); denied(); }
  let size = 0; const chunks = [];
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) denied();
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { denied(); }
}

/** Read-only confirmation of the native call, using the owner's existing
 * OpenCode transport. It never prompts, approves, retries or executes a tool.
 * Runtime credentials and the current selection are resolved by server-owned
 * authorities, not from model arguments or caller-supplied upstream addresses.
 */
export class PenpotNativeCallVerifier {
  #routes; #authenticateRuntime; #resolveBinding;
  constructor({ routes, authenticateRuntime, resolveBinding }) {
    if (!routes?.resolve || typeof authenticateRuntime !== 'function' || typeof resolveBinding !== 'function') {
      throw new TypeError('Existing runtime authentication, routes and design binding are required');
    }
    this.#routes = routes; this.#authenticateRuntime = authenticateRuntime; this.#resolveBinding = resolveBinding;
  }

  async verify(runtimeAuthentication, call) {
    if (!call || call.server !== 'teamaibox-penpot'
      || !['server', 'tool', 'sessionID', 'messageID', 'callID'].every(key => ID.test(call[key] ?? ''))) denied();
    const principal = await this.#authenticateRuntime(runtimeAuthentication);
    if (!principal || !ID.test(principal.identityId ?? '') || !ID.test(principal.runtimeId ?? '')
      || !/^sandbox\.[a-f0-9]{32}$/.test(principal.sandboxKey ?? '')) denied();
    const selected = await this.#resolveBinding(principal.identityId);
    if (!selected || selected.identityId !== principal.identityId || selected.runtimeId !== principal.runtimeId
      || selected.sessionID !== call.sessionID) denied();
    const route = await this.#routes.resolve(principal.identityId);
    if (route?.ownerIdentityId !== principal.identityId || route.sandboxKey !== principal.sandboxKey || !route.native?.request) denied();
    const signal = AbortSignal.timeout(3000);
    try {
      const session = await boundedJson(await route.native.request('GET', '/session/' + call.sessionID, { signal }));
      // Native project directories come from the owned runtime, never a model
      // or the callback body. Reuse the native transport's workspace checks.
      if (session?.id !== call.sessionID || typeof session.directory !== 'string'
        || (session.directory !== '/workspace' && !session.directory.startsWith('/workspace/'))
        || /[\\\r\n\0]/.test(session.directory)
        || session.directory.split('/').some(part => part === '.' || part === '..') || session.time?.archived) denied();
      const message = await boundedJson(await route.native.request('GET',
        '/session/' + call.sessionID + '/message/' + call.messageID + '?directory=' + encodeURIComponent(session.directory), { signal }));
      if (message?.info?.id !== call.messageID || message.info.sessionID !== call.sessionID
        || message.info.role !== 'assistant' || message.info.time?.completed || !Array.isArray(message.parts)) denied();
      const parts = message.parts.filter(part => part.type === 'tool' && part.callID === call.callID);
      if (parts.length !== 1 || parts[0].sessionID !== call.sessionID || parts[0].messageID !== call.messageID
        || parts[0].tool !== 'teamaibox-penpot_' + call.tool || !['pending', 'running'].includes(parts[0].state?.status)) denied();
      // Awaiting native HTTP must not let a changed login, runtime or selected
      // file acquire a proof for the previous request.
      const latestPrincipal = await this.#authenticateRuntime(runtimeAuthentication);
      const current = await this.#resolveBinding(principal.identityId);
      if (latestPrincipal?.identityId !== principal.identityId || latestPrincipal.runtimeId !== principal.runtimeId
        || latestPrincipal.sandboxKey !== principal.sandboxKey
        || !current || ['identityId', 'platformSessionId', 'runtimeId', 'sessionID', 'connectionId',
          'generation', 'profileId', 'fileId', 'pageId'].some(key => current[key] !== selected[key])) denied();
      return Object.freeze({ identityId: principal.identityId, runtimeId: principal.runtimeId });
    } catch { denied(); }
  }
}
