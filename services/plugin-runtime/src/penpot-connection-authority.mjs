import { randomUUID } from 'node:crypto';
import { PlatformError } from '../../../packages/observability/src/index.mjs';
import { penpotCredentialOwner } from '../../agent-bridge/src/penpot-runtime-credential.mjs';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const denied = () => { throw new PlatformError('penpot_connection_denied', 'The design connection is no longer available', { status: 403 }); };
const FIELDS = ['identityId', 'platformSessionId', 'runtimeId', 'sessionID', 'connectionId', 'generation', 'profileId', 'fileId', 'pageId'];

/** Current selection only. Native Penpot owns document rights, existing IAM
 * owns platform access and OpenCode still executes all tools. */
export class PenpotConnectionAuthority {
  #repository; #platform; #native; #routes; #clock;
  constructor({ repository, platform, nativePermissions, routes, clock = () => Date.now() }) {
    if (!repository?.get || !repository?.select || !platform?.loadSession || !platform?.authenticateNativeSession || !platform?.validateNativeBinding
      || !nativePermissions?.check || !routes?.resolve) throw new TypeError('Current design authorities are required');
    this.#repository = repository; this.#platform = platform; this.#native = nativePermissions;
    this.#routes = routes; this.#clock = clock;
  }
  #now() { const now = this.#clock(); if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid connection clock'); return now; }
  async #route(identityId, reportUpgrade = false) {
    const route = await this.#routes.resolve(identityId);
    if (route?.ownerIdentityId !== identityId || !/^sandbox\.[a-f0-9]{32}$/.test(route.sandboxKey ?? '')) denied();
    if (reportUpgrade && route.designRuntimeStatus === 'upgrade_required' && route.designRuntime === null) {
      throw new PlatformError('penpot_agent_upgrade_required', 'The current assistant workspace has not been updated for Design', { status: 409 });
    }
    if (!/^[a-f0-9]{64}$/.test(route.designRuntime?.runtimeId ?? '')) denied();
    return route;
  }
  async authenticateRuntime(credential) {
    const identityId = penpotCredentialOwner(credential);
    if (!identityId) denied();
    const route = await this.#route(identityId);
    if (!route.designRuntime.accepts(credential)) denied();
    return { identityId, runtimeId: route.designRuntime.runtimeId, sandboxKey: route.sandboxKey };
  }
  async current({ context, nativeToken }) {
    const user = await this.#platform.authenticateNativeSession({ context, nativeToken });
    const row = await this.#repository.get(user.identityId);
    const result = { generation: row?.generation ?? 0, connected: false };
    if (row?.platformSessionId !== user.platformSessionId || row?.profileId !== user.profileId) return result;
    try { return { ...result, connected: true, target: await this.resolveCurrentBinding(user.identityId) }; }
    catch { return result; }
  }
  async editorTransport({ context, nativeToken, connectionId }) {
    const user = await this.#platform.authenticateNativeSession({ context, nativeToken });
    const binding = await this.resolveCurrentBinding(user.identityId);
    if (binding.connectionId !== connectionId || binding.platformSessionId !== user.platformSessionId
      || binding.profileId !== user.profileId) denied();
    const route = await this.#route(user.identityId);
    if (route.designRuntime.runtimeId !== binding.runtimeId || typeof route.designRuntime.credential !== 'function') denied();
    return { binding, userToken: route.designRuntime.credential() };
  }
  async select({ context, nativeToken, sessionID, fileId, pageId, expectedGeneration }) {
    if (!ID.test(sessionID ?? '') || !UUID.test(fileId ?? '') || !UUID.test(pageId ?? '')
      || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) denied();
    const user = await this.#platform.authenticateNativeSession({ context, nativeToken });
    const route = await this.#route(user.identityId, true);
    const response = await route.native.request('GET', '/session/' + sessionID, { signal: AbortSignal.timeout(3000) });
    if (!response.ok || Number(response.headers.get('content-length')) > 65536) { await response.body?.cancel(); denied(); }
    let length = 0; const chunks = [];
    for await (const chunk of response.body) { length += chunk.length; if (length > 65536) denied(); chunks.push(chunk); }
    const session = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (session.id !== sessionID || session.time?.archived || typeof session.directory !== 'string'
      || (session.directory !== '/workspace' && !session.directory.startsWith('/workspace/'))
      || /[\\\0\r\n]/.test(session.directory) || session.directory.split('/').some(p => p === '..' || p === '.')) denied();
    const target = await this.#native.check({ profileId: user.profileId, fileId, pageId });
    // Official execute_code combines reads/writes; never give it to a viewer.
    if (!target.canEdit) denied();
    await this.#platform.validateNativeBinding(user);
    const latest = await this.#route(user.identityId);
    if (latest.designRuntime.runtimeId !== route.designRuntime.runtimeId) denied();
    const binding = { ...user, runtimeId: route.designRuntime.runtimeId, sessionID, fileId, pageId, connectionId: randomUUID() };
    const generation = await this.#repository.select({ identityId: user.identityId, binding, expectedGeneration, now: this.#now() });
    if (generation === null) throw new PlatformError('penpot_connection_changed', 'Select the current design connection explicitly', { status: 409 });
    // Raw cookies and their server-side digest references do not leave this
    // authority. Only the target context is returned to the editor.
    return Object.freeze(Object.fromEntries(FIELDS.map(key => [key, key === 'generation' ? generation : binding[key]])));
  }
  async resolveCurrentBinding(identityId) {
    const row = await this.#repository.get(identityId), now = this.#now();
    if (!row || row.identityId !== identityId || row.disconnected || row.heartbeatAt > now || now - row.heartbeatAt >= 12000) denied();
    await this.#platform.validateNativeBinding(row);
    const route = await this.#route(identityId);
    if (row.runtimeId !== route.designRuntime.runtimeId) denied();
    if (!(await this.#native.check(row)).canEdit) denied();
    await this.#platform.validateNativeBinding(row);
    if ((await this.#route(identityId)).designRuntime.runtimeId !== row.runtimeId) denied();
    const current = await this.#repository.get(identityId), end = this.#now();
    if (!current || current.disconnected || current.heartbeatAt > end || end - current.heartbeatAt >= 12000
      || FIELDS.some(key => current[key] !== row[key])) denied();
    return Object.freeze(Object.fromEntries(FIELDS.map(key => [key, current[key]])));
  }
  async heartbeat({ context, nativeToken, connectionId, generation }) {
    const user = await this.#platform.authenticateNativeSession({ context, nativeToken });
    const binding = await this.resolveCurrentBinding(user.identityId);
    if (binding.platformSessionId !== user.platformSessionId || binding.profileId !== user.profileId
      || binding.connectionId !== connectionId || binding.generation !== generation) denied();
    if (!await this.#repository.heartbeat({ ...binding, now: this.#now() })) denied();
    return binding;
  }
  async disconnect({ context, nativeToken, connectionId, generation }) {
    const user = await this.#platform.authenticateNativeSession({ context, nativeToken });
    if (!UUID.test(connectionId ?? '') || !Number.isSafeInteger(generation) || generation < 1) denied();
    if (!await this.#repository.disconnect({ ...user, connectionId, generation, now: this.#now() })) denied();
    return { disconnected: true };
  }
}
