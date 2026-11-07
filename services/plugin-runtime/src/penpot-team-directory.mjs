import {randomUUID} from 'node:crypto';
import {PlatformError} from '../../../packages/observability/src/index.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deny=()=>{throw new PlatformError('penpot_team_denied','The design team is not accessible',{status:403});};
const roles=Object.freeze({team_admin:'admin',member:'editor',developer:'editor',guest:'viewer'});

/** Directory membership is a ceiling, never a substitute for native file ACLs.
 * Appliance administrators need explicit team membership like anyone else.
 * Mapping creation alone grants no native access and transfers no ownership.
 */
export class PenpotTeamDirectory {
  #db;#installation;#authority;#clock;
  constructor({database,installationId,authority,clock=()=>new Date()}){
    if(!database?.query||!UUID.test(installationId??'')||!authority?.authorizeDesign)throw new TypeError('Design team authorities are required');
    this.#db=database;this.#installation=installationId;this.#authority=authority;this.#clock=clock;
  }
  #now(){const now=new Date(this.#clock());if(!Number.isFinite(now.getTime()))deny();return now;}
  async #identity(context){
    const id=context?.identityId??context?.identity?.id;
    if(!UUID.test(id??'')||!(await this.#authority.authorizeDesign(context,this.#now())).allowed)deny();
    return id;
  }
  async list(context){
    const id=await this.#identity(context);
    const {rows}=await this.#db.query(`SELECT team.id,team.display_name,role.role_key,
      CASE WHEN mapping.activated_at IS NOT NULL THEN mapping.native_team_id END AS native_team_id
      FROM iam.teams team JOIN iam.role_bindings binding
        ON binding.scope_kind='team' AND binding.scope_key=team.team_key
      JOIN iam.roles role ON role.id=binding.role_id
      LEFT JOIN design.team_mappings mapping ON mapping.platform_team_id=team.id AND mapping.installation_id=$2
      WHERE binding.identity_id=$1 AND team.status='active'
        AND (binding.expires_at IS NULL OR binding.expires_at>$3)
      ORDER BY team.display_name,team.id`,[id,this.#installation,this.#now()]);
    await this.#identity(context);
    return rows.filter(row=>Object.hasOwn(roles,row.role_key)).map(row=>Object.freeze({
      teamId:row.id,name:row.display_name,role:roles[row.role_key],nativeTeamId:row.native_team_id??null}));
  }
  async ensureMapping(context,teamId){
    const id=await this.#identity(context);if(!UUID.test(teamId??''))deny();
    const {rows}=await this.#db.query(`INSERT INTO design.team_mappings
      (installation_id,platform_team_id,native_team_id,created_by)
      SELECT $1,team.id,$4,$2 FROM iam.teams team
      JOIN iam.role_bindings binding ON binding.scope_kind='team' AND binding.scope_key=team.team_key
      JOIN iam.roles role ON role.id=binding.role_id
      WHERE team.id=$3 AND team.status='active' AND binding.identity_id=$2 AND role.role_key='team_admin'
        AND (binding.expires_at IS NULL OR binding.expires_at>$5)
      ON CONFLICT (installation_id,platform_team_id) DO UPDATE SET platform_team_id=EXCLUDED.platform_team_id
      RETURNING native_team_id`,[this.#installation,id,teamId,randomUUID(),this.#now()]);
    await this.#identity(context);
    if(rows.length!==1)deny();
    return Object.freeze({teamId,nativeTeamId:rows[0].native_team_id});
  }
  async profileFor(context){
    const id=await this.#identity(context);
    const {rows}=await this.#db.query('SELECT profile_id FROM design.profile_mappings WHERE installation_id=$1 AND identity_id=$2',
      [this.#installation,id]);
    if(!UUID.test(rows[0]?.profile_id??''))deny();
    return rows[0].profile_id;
  }
  async confirmActivation(context,{teamId,nativeTeamId}){
    const id=await this.#identity(context);
    if(![teamId,nativeTeamId].every(value=>UUID.test(value??'')))deny();
    const {rowCount}=await this.#db.query(`UPDATE design.team_mappings mapping
      SET activated_at=COALESCE(mapping.activated_at,$5)
      FROM iam.teams team JOIN iam.role_bindings binding
        ON binding.scope_kind='team' AND binding.scope_key=team.team_key
      JOIN iam.roles role ON role.id=binding.role_id
      WHERE mapping.installation_id=$1 AND mapping.platform_team_id=$3 AND mapping.native_team_id=$4
        AND team.id=mapping.platform_team_id AND team.status='active' AND binding.identity_id=$2
        AND role.role_key='team_admin' AND (binding.expires_at IS NULL OR binding.expires_at>$5)`,
      [this.#installation,id,teamId,nativeTeamId,this.#now()]);
    if(rowCount!==1)deny();
  }
  async activeProfile(identityId){
    if(!UUID.test(identityId??''))deny();
    const {rows}=await this.#db.query(`SELECT profile.profile_id FROM design.profile_mappings profile
      JOIN iam.identities identity ON identity.id=profile.identity_id AND identity.status='active'
      WHERE profile.installation_id=$1 AND profile.identity_id=$2`,[this.#installation,identityId]);
    if(!UUID.test(rows[0]?.profile_id??''))deny();
    return rows[0].profile_id;
  }
  /** Service-only projection. Absent roles deliberately do not appear, so
   * native reconciliation can remove only this profile's managed grants. */
  async snapshot(profileId){
    if(!UUID.test(profileId??''))deny();
    const {rows}=await this.#db.query(`SELECT profile.profile_id, membership.native_team_id,membership.role_key
      FROM design.profile_mappings profile
      JOIN iam.identities identity ON identity.id=profile.identity_id AND identity.status='active'
      LEFT JOIN LATERAL (
        SELECT mapping.native_team_id,role.role_key FROM iam.role_bindings binding
        JOIN iam.roles role ON role.id=binding.role_id
        JOIN iam.teams team ON team.team_key=binding.scope_key AND team.status='active'
        JOIN design.team_mappings mapping ON mapping.installation_id=profile.installation_id AND mapping.platform_team_id=team.id
        WHERE binding.scope_kind='team' AND binding.identity_id=profile.identity_id
          AND (binding.expires_at IS NULL OR binding.expires_at>$3)
      ) membership ON true
      WHERE profile.installation_id=$1 AND profile.profile_id=$2
      LIMIT 1001`,[this.#installation,profileId,this.#now()]);
    if(!rows.length||rows.length>=1001)deny();
    const memberships=rows.filter(row=>Object.hasOwn(roles,row.role_key)).map(row=>{
      if(!UUID.test(row.native_team_id??''))deny();
      return {teamId:row.native_team_id,role:roles[row.role_key]};
    });
    if(new Set(memberships.map(value=>value.teamId)).size!==memberships.length)deny();
    return {profileId,memberships};
  }
  async ceiling({profileId,teamId}){
    if(!UUID.test(profileId??'')||!UUID.test(teamId??''))deny();
    // One database snapshot: a profile, team mapping and directory role
    // must not be assembled from different states during a team change.
    const {rows}=await this.#db.query(`SELECT mapping.installation_id AS team_installation_id, role.role_key
      FROM design.profile_mappings profile
      JOIN iam.identities identity ON identity.id=profile.identity_id AND identity.status='active'
      LEFT JOIN design.team_mappings mapping ON mapping.native_team_id=$3
      LEFT JOIN iam.teams team ON team.id=mapping.platform_team_id AND team.status='active'
      LEFT JOIN iam.role_bindings binding ON binding.scope_kind='team' AND binding.scope_key=team.team_key
        AND binding.identity_id=profile.identity_id AND (binding.expires_at IS NULL OR binding.expires_at>$4)
      LEFT JOIN iam.roles role ON role.id=binding.role_id
      WHERE profile.installation_id=$1 AND profile.profile_id=$2`,[this.#installation,profileId,teamId,this.#now()]);
    if(rows.length!==1)deny();
    const row=rows[0];
    // Native personal spaces still require native file ACLs. This response is
    // only a ceiling; callers must never interpret it as an access grant.
    if(row.team_installation_id===null)return Object.freeze({managed:false,canRead:true,canEdit:true});
    if(row.team_installation_id!==this.#installation||!Object.hasOwn(roles,row.role_key))deny();
    return Object.freeze({managed:true,canRead:true,canEdit:roles[row.role_key]!=='viewer'});
  }
}
