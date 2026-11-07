import { PlatformError } from '../../../../packages/observability/src/index.mjs';
import { timingSafeEqual } from 'node:crypto';

const ISSUE = '/api/v1/design/login-handoff';
const REDEEM = '/internal/v1/design/login-handoff';
const STATUS = '/api/v1/design/status';
const TEAM_ROLES = '/internal/v1/design/team-roles';
const IMPORT_CHECK = '/internal/v1/design/drive-import-check';
const TEAMS = '/api/v1/design/teams';

export class PenpotHandoffHttpApi {
  #handoff;
  #readiness;
  #teams;
  constructor({ handoff, readiness = null, teams = null }) {
    if (!handoff?.issue || !handoff?.redeem) throw new TypeError('Design handoff is required');
    this.#handoff = handoff;
    if(readiness!==null&&typeof readiness.inspect!=='function')throw new TypeError('Invalid design readiness service');
    this.#readiness = readiness;
    if (teams && (!teams.directory?.snapshot || !teams.native?.ensureTeam || !teams.authentication?.authenticateSession
        || !/^[A-Za-z0-9_-]{43}$/.test(teams.backendKey ?? ''))) throw new TypeError('Invalid design team configuration');
    this.#teams = teams;
  }
  matches(method, pathname) {
    return method === 'POST' && ([ISSUE, REDEEM].includes(pathname)
      || pathname === STATUS && this.#readiness !== null
      || pathname === IMPORT_CHECK && Boolean(this.#teams?.importer)
      || [TEAM_ROLES, TEAMS].includes(pathname) && this.#teams !== null);
  }
  isPrivate(pathname) { return [REDEEM,TEAM_ROLES,IMPORT_CHECK].includes(pathname); }
  async handle({ pathname, sessionToken, csrfToken, body, headers = {} }) {
    try {
      if ([TEAM_ROLES,IMPORT_CHECK].includes(pathname) && this.#teams) {
        const expected = Buffer.from('Bearer ' + this.#teams.backendKey);
        const supplied = Buffer.from(typeof headers.authorization === 'string' ? headers.authorization : '');
        if (headers.cookie || headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied,expected)
            || !body || typeof body!=='object' || Array.isArray(body) || typeof body.profileId !== 'string') {
          throw new PlatformError('penpot_team_denied','Design team access is unavailable',{status:403});
        }
        if(pathname===IMPORT_CHECK){
          if(!this.#teams.importer||Object.keys(body).length!==3
            ||Object.keys(body).some(key=>!['profileId','operationId','sourceDigest'].includes(key)))
            throw new PlatformError('penpot_drive_import_denied','Design import confirmation is unavailable',{status:403});
          await this.#teams.importer.confirm(body);
          return {status:200,body:{confirmed:true}};
        }
        if(Object.keys(body).length!==1)throw new PlatformError('penpot_team_denied','Design team access is unavailable',{status:403});
        return {status:200,body:await this.#teams.directory.snapshot(body.profileId)};
      }
      if (pathname === TEAMS && this.#teams) {
        if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some(key => key !== 'teamId'))) {
          throw new PlatformError('invalid_request','Invalid design team request',{status:400});
        }
        const context = await this.#teams.authentication.authenticateSession({sessionToken,csrfToken,requireCsrf:true});
        const teams = await this.#teams.directory.list(context);
        if (!Object.hasOwn(body??{},'teamId')) return {status:200,body:{teams}};
        const team = teams.find(entry => entry.teamId === body.teamId && entry.role === 'admin');
        if (!team) throw new PlatformError('penpot_team_denied','Design team access is unavailable',{status:403});
        // The authenticated editor profile must already exist (launch Design first).
        const profileId = await this.#teams.directory.profileFor(context);
        const mapping = await this.#teams.directory.ensureMapping(context,team.teamId);
        await this.#teams.native.ensureTeam({profileId,teamId:mapping.nativeTeamId,name:team.name});
        // A failed native call (including a lost reply) leaves an allocated
        // mapping that the same administrator can explicitly retry.
        await this.#teams.directory.confirmActivation(context,mapping);
        return {status:200,body:mapping};
      }
      if(pathname===STATUS&&this.#readiness){
        if(body!==undefined&&(body===null||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length))throw new PlatformError('invalid_request','Design status takes no parameters',{status:400});
        return {status:200,body:await this.#readiness.inspect({sessionToken,csrfToken})};
      }
      if (pathname === ISSUE) {
        if (body && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) {
          throw new PlatformError('invalid_request', 'Design sign-in takes no target or identity parameters', { status: 400 });
        }
        return { status: 201, body: await this.#handoff.issue({ sessionToken, csrfToken }) };
      }
      if (pathname === REDEEM) {
        const key = typeof headers.authorization === 'string'
          ? /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(headers.authorization)?.[1] : null;
        if (!key || headers.cookie || headers.origin || !body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(name => !['code', 'identityId', 'sessionId'].includes(name))) {
          throw new PlatformError('penpot_handoff_denied', 'Design sign-in is unavailable or has expired', { status: 403 });
        }
        return { status: 200, body: await this.#handoff.redeem({ ...body, backendKey: key }) };
      }
      throw new PlatformError('not_found', 'Design sign-in endpoint was not found', { status: 404 });
    } catch (error) {
      if (error?.code === 'penpot_handoff_denied' || error?.code === 'penpot_access_denied') {
        throw new PlatformError(error.code, 'Design sign-in is unavailable or has expired', { status: 403 });
      }
      throw error;
    }
  }
}
