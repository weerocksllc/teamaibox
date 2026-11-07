import { createHmac } from 'node:crypto';
import { PostgresDelegatedAccessControl } from './postgres-delegated-access-control.mjs';
import { PlatformError } from '../../../packages/observability/src/index.mjs';

const APP = 'official.penpot';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const denied = () => { throw new PlatformError('penpot_access_denied',
  'Design access is unavailable or has expired', { status: 403 }); };

/** Uses the existing platform session/role authority. Native Penpot continues
 * to enforce project/file ACLs; platform administrators gain no content grant.
 * A native cookie is usable only with the platform session that obtained it.
 */
export class PenpotPlatformAuthority {
  #database; #access; #installationId; #pepper; #clock; #closed = false;
  constructor({ database, installationId, tokenPepper, clock = () => new Date() }) {
    if (!database?.query || !UUID.test(installationId ?? '')
      || !(tokenPepper instanceof Uint8Array) || tokenPepper.byteLength < 32 || typeof clock !== 'function') {
      throw new TypeError('Design access requires persistent platform identity and private credentials');
    }
    this.#database = database;
    this.#access = new PostgresDelegatedAccessControl({ database });
    this.#installationId = installationId;
    this.#pepper = Buffer.from(tokenPepper);
    this.#clock = clock;
  }

  #now(value = this.#clock()) {
    if (this.#closed) denied();
    const now = new Date(value);
    if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid design access clock');
    return now;
  }

  async loadSession(identityId, sessionId, now = this.#clock()) {
    const current = await this.#access.loadSession(identityId, sessionId, this.#now(now));
    if (!current) return null;
    const { rows } = await this.#database.query('SELECT display_name FROM iam.identities WHERE id=$1', [identityId]);
    return Object.freeze({ ...current, displayName: rows[0]?.display_name ?? 'Team member' });
  }

  async authorizeDesign(context, now = this.#clock()) {
    const identityId = context?.identityId ?? context?.identity?.id;
    now = this.#now(now);
    if (!UUID.test(identityId ?? '') || !UUID.test(context?.sessionId ?? '')) return { pluginId: APP, allowed: false };
    const request = { identityId, sessionId: context.sessionId, permission: 'design:use', now };
    let allowed = await this.#access.authorize({ ...request, resource: { kind: 'application', key: APP } });
    if (!allowed) {
      // Ordinary members have a team-scoped platform role, not an appliance
      // administrator role. Entry may come from an active team; native design
      // membership and file ACLs still determine which content they can see.
      const { rows } = await this.#database.query(`SELECT team.team_key FROM iam.teams team
        JOIN iam.role_bindings binding ON binding.scope_kind='team' AND binding.scope_key=team.team_key
        WHERE binding.identity_id=$1 AND team.status='active'
          AND (binding.expires_at IS NULL OR binding.expires_at>$2)`, [identityId, now]);
      for (const team of rows) {
        if (await this.#access.authorize({ ...request, resource: { kind: 'team', key: team.team_key } })) {
          allowed = true; break;
        }
      }
    }
    if (!allowed) return Object.freeze({ pluginId: APP, allowed: false });
    const { rows } = await this.#database.query(`SELECT version.version, plugin.generation
      FROM plugins.plugins plugin
      JOIN plugins.plugin_versions version ON version.id=plugin.current_version_id
      JOIN plugins.runtime_slots slot ON slot.plugin_id=plugin.id AND slot.slot=plugin.active_slot
      WHERE plugin.plugin_key=$1 AND plugin.lifecycle_state='enabled'
        AND version.install_state='healthy' AND slot.slot_state='active'
        AND slot.plugin_version_id=version.id`, [APP]);
    const row = rows[0], generation = Number(row?.generation);
    if (!row || !Number.isSafeInteger(generation) || generation <= 0) return Object.freeze({ pluginId: APP, allowed: false });
    return Object.freeze({ pluginId: APP, allowed: true, version: row.version, generation });
  }

  #hash(nativeToken) {
    if (typeof nativeToken !== 'string' || !/^[A-Za-z0-9_.~=-]{20,4096}$/.test(nativeToken)) denied();
    return createHmac('sha256', this.#pepper).update('penpot-native-session\0').update(nativeToken).digest();
  }

  /** Private proxy only, after successful native login. Never a browser API. */
  async bindNativeSession({ context, profileId, nativeToken }) {
    const hash = this.#hash(nativeToken), now = this.#now();
    if (!UUID.test(profileId ?? '')) denied();
    const identityId = context?.identityId ?? context?.identity?.id;
    const access = await this.authorizeDesign(context, now);
    if (!access.allowed) denied();
    const { rows } = await this.#database.query(`INSERT INTO design.native_sessions
      (token_hash, installation_id, identity_id, session_id, profile_id, app_version, app_generation, expires_at)
      SELECT $1, mapping.installation_id, mapping.identity_id, $4, mapping.profile_id, $6, $7, $8
      FROM design.profile_mappings mapping
      WHERE mapping.installation_id=$2 AND mapping.identity_id=$3 AND mapping.profile_id=$5
      ON CONFLICT DO NOTHING RETURNING profile_id`,
    [hash, this.#installationId, identityId, context.sessionId, profileId, access.version, access.generation,
      new Date(now.getTime() + 24 * 60 * 60 * 1000)]);
    if (rows[0]?.profile_id !== profileId) denied();
    return Object.freeze({ profileId });
  }

  async authenticateNativeSession({ context, nativeToken }) {
    const hash = this.#hash(nativeToken), now = this.#now();
    const identityId = context?.identityId ?? context?.identity?.id;
    const access = await this.authorizeDesign(context, now);
    if (!access.allowed) denied();
    const { rows } = await this.#database.query(`SELECT native.profile_id
      FROM design.native_sessions native
      JOIN design.profile_mappings mapping ON mapping.installation_id=native.installation_id
        AND mapping.identity_id=native.identity_id AND mapping.profile_id=native.profile_id
      WHERE native.token_hash=$1 AND native.installation_id=$2 AND native.identity_id=$3
        AND native.session_id=$4 AND native.app_version=$5 AND native.app_generation=$6
        AND native.expires_at>$7`,
    [hash, this.#installationId, identityId, context.sessionId, access.version, access.generation, now]);
    if (!UUID.test(rows[0]?.profile_id ?? '')) denied();
    return Object.freeze({ identityId, platformSessionId: context.sessionId, profileId: rows[0].profile_id,
      nativeSessionHash: hash.toString('hex'), appVersion: access.version, appGeneration: access.generation });
  }

  /** Recheck a server-stored editor binding without storing its raw cookie.
   * Re-entry or an enabled replacement app generation does not revive the old
   * connection: it must select a target under its current native session. */
  async validateNativeBinding(binding) {
    const now = this.#now();
    if (!/^[a-f0-9]{64}$/.test(binding?.nativeSessionHash ?? '')
      || ![binding.identityId, binding.platformSessionId, binding.profileId].every(value => UUID.test(value ?? ''))) denied();
    const context = await this.loadSession(binding.identityId, binding.platformSessionId, now);
    if (!context) denied();
    const access = await this.authorizeDesign(context, now);
    if (!access.allowed || access.version !== binding.appVersion || access.generation !== binding.appGeneration) denied();
    const { rows } = await this.#database.query(`SELECT 1 FROM design.native_sessions native
      JOIN design.profile_mappings mapping ON mapping.installation_id=native.installation_id
        AND mapping.identity_id=native.identity_id AND mapping.profile_id=native.profile_id
      WHERE native.token_hash=$1 AND native.installation_id=$2 AND native.identity_id=$3
        AND native.session_id=$4 AND native.profile_id=$5 AND native.app_version=$6
        AND native.app_generation=$7 AND native.expires_at>$8`,
    [Buffer.from(binding.nativeSessionHash, 'hex'), this.#installationId, binding.identityId,
      binding.platformSessionId, binding.profileId, access.version, access.generation, now]);
    if (rows.length !== 1) denied();
  }

  async revokeSession(identityId, sessionId) {
    if (!UUID.test(identityId ?? '') || !UUID.test(sessionId ?? '')) denied();
    await this.#database.query(`DELETE FROM design.native_sessions
      WHERE installation_id=$1 AND identity_id=$2 AND session_id=$3`,
    [this.#installationId, identityId, sessionId]);
    // Identity mappings and native projects are deliberately retained.
  }

  close() { this.#closed = true; this.#pepper.fill(0); }
}
