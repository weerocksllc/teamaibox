import { PlatformError } from '../../../packages/observability/src/index.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const denied = () => { throw new PlatformError('penpot_target_denied', 'The design target is not accessible', { status: 403 }); };

/** Bounded read-only native ACL query. No browser token, design content, native
 * administrator identity, URL supplied by a caller, or permission cache. */
export class PenpotNativePermissions {
  #origin; #key; #fetch; #teamCeiling;
  constructor({ backendOrigin, backendKey, fetchImplementation = fetch, teamCeiling = null }) {
    const origin = new URL(backendOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash || !/^[A-Za-z0-9_-]{43}$/.test(backendKey ?? '')) {
      throw new TypeError('Private design permission service configuration is required');
    }
    this.#origin = origin;
    if (teamCeiling !== null && typeof teamCeiling !== 'function') throw new TypeError('Invalid design team authority');
    this.#key = backendKey; this.#fetch = fetchImplementation; this.#teamCeiling = teamCeiling;
  }
  async #query(method, body, timeout) {
    const response = await this.#fetch(new URL('/api/main/methods/' + method, this.#origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); denied(); }
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length; if (size > 8192) denied(); chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async checkSubscriptions({ profileId, connectionId }) {
    if (![profileId, connectionId].every(value => UUID.test(value ?? ''))) denied();
    try {
      const value = await this.#query('teamaibox-subscription-access', {'target-profile-id':profileId,'connection-id':connectionId}, 850);
      if (value.profileId !== profileId || value.connectionId !== connectionId
        || !Array.isArray(value.teamIds) || value.teamIds.length > 2
        || new Set(value.teamIds).size !== value.teamIds.length
        || value.teamIds.some(id => !UUID.test(id ?? ''))) denied();
      if (this.#teamCeiling) {
        const scopes = await Promise.all(value.teamIds.map(teamId => this.#teamCeiling({profileId,teamId})));
        if (scopes.some(scope => scope?.canRead !== true)) denied();
      }
    } catch { denied(); }
  }
  async ensureTeam({profileId,teamId,name}){
    if (![profileId,teamId].every(id=>UUID.test(id??'')) || typeof name!=='string' || !name.trim() || name.length>250) denied();
    try{
      const value=await this.#query('teamaibox-ensure-team',{'target-profile-id':profileId,'team-id':teamId,name},5000);
      if(value.teamId!==teamId)denied();
    }catch{denied();}
  }
  async #file({ profileId, fileId, pageId }) {
    if (![profileId, fileId, pageId].every(value => UUID.test(value ?? ''))) denied();
    try {
      const value = await this.#query('teamaibox-file-access', { 'target-profile-id': profileId, 'file-id': fileId, 'page-id': pageId }, 2500);
      // Penpot's native JSON response encoder converts keyword keys to camelCase.
      if (value.profileId !== profileId || value.fileId !== fileId || value.pageId !== pageId
        || !UUID.test(value.teamId ?? '') || value.canRead !== true || typeof value.canEdit !== 'boolean') denied();
      const ceiling = this.#teamCeiling ? await this.#teamCeiling({profileId,teamId:value.teamId}) : {canRead:true,canEdit:true};
      if (ceiling?.canRead !== true || typeof ceiling.canEdit !== 'boolean') denied();
      return {access:Object.freeze({profileId,fileId,pageId,teamId:value.teamId,canRead:true,canEdit:value.canEdit&&ceiling.canEdit}),
        revision:value.revision,documentVersion:value.documentVersion,modifiedAt:value.modifiedAt};
    } catch { denied(); }
  }
  async check(target) {return (await this.#file(target)).access;}
  async savedRevision(target) {
    const {revision,documentVersion,modifiedAt}=await this.#file(target);
    if(!Number.isSafeInteger(revision)||revision<0||!Number.isSafeInteger(documentVersion)||documentVersion<0
       ||typeof modifiedAt!=='string'||!Number.isFinite(Date.parse(modifiedAt)))denied();
    return {revision,documentVersion,modifiedAt};
  }
}
