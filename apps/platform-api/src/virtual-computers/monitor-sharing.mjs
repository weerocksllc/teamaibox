import {computerId,computerError} from './lifecycle.mjs';

/** Monitor grants never change ownership, guest lifecycle or RDP authorization. */
export class MonitorSharing {
  #db; #directory; #repository;
  constructor({database,directory,repository}){this.#db=database;this.#directory=directory;this.#repository=repository;}
  async actor(context){
    if(!context?.sessionId||!context?.identityId)computerError('invalid_session',401);
    const auth=await this.#directory.authorization(computerId(context.identityId));
    if(!auth?.permissions.includes('computer:use'))computerError('computer_permission_required',403);
    return auth;
  }
  async resolve({context,computerId:id,running=false}){
    const auth=await this.actor(context),identityId=auth.identityId;
    const row=(await this.#db.query(`SELECT c.owner_id,g.permission FROM platform.computers c
      JOIN iam.identities owner ON owner.id=c.owner_id AND owner.status='active'
      LEFT JOIN platform.computer_monitor_grants g ON g.computer_id=c.id AND g.identity_id=$2
      WHERE c.id=$1 AND c.state<>'deleted' AND (c.owner_id=$2 OR g.identity_id IS NOT NULL)`,[computerId(id),identityId])).rows[0];
    if(!row)computerError('computer_not_found',404);
    const c=await this.#repository.get(row.owner_id,id);
    if(running&&(!['running','stopping'].includes(c.state)||!c.run?.containerId))computerError('computer_runtime_unavailable',503);
    return {...c,runId:c.run?.id,monitorRole:c.ownerId===identityId?'owner':row.permission,
      actorName:auth.identity?.displayName??auth.identity?.username??'Member'};
  }
  async invitations(context){
    const {identityId}=await this.actor(context);
    const rows=(await this.#db.query(`SELECT c.id,c.name,c.state,g.permission,i.display_name AS owner_name
      FROM platform.computer_monitor_grants g JOIN platform.computers c ON c.id=g.computer_id
      JOIN iam.identities i ON i.id=c.owner_id AND i.status='active'
      WHERE g.identity_id=$1 AND c.state<>'deleted' ORDER BY g.updated_at DESC,c.id`,[identityId])).rows;
    return {data:rows.map(r=>({id:r.id,name:r.name,state:r.state,permission:r.permission,ownerName:r.owner_name}))};
  }
  async grants(context,id){
    const c=await this.resolve({context,computerId:id});
    if(c.monitorRole!=='owner')computerError('computer_permission_required',403);
    return {data:(await this.#db.query(`SELECT g.identity_id AS "identityId",g.permission,i.display_name AS "displayName",i.login_name AS username
      FROM platform.computer_monitor_grants g JOIN iam.identities i ON i.id=g.identity_id
      WHERE g.computer_id=$1 ORDER BY g.updated_at,g.identity_id`,[id])).rows};
  }
  async update(context,id,input){
    const c=await this.resolve({context,computerId:id});
    if(c.monitorRole!=='owner')computerError('computer_permission_required',403);
    if(!input||Object.keys(input).some(k=>!['identityId','permission'].includes(k))||!['view','control',null].includes(input.permission))computerError('computer_input_invalid',400);
    const member=computerId(input.identityId);
    if(member===c.ownerId)computerError('computer_input_invalid',400);
    if(input.permission===null)await this.#db.query('DELETE FROM platform.computer_monitor_grants WHERE computer_id=$1 AND identity_id=$2',[id,member]);
    else{
      const auth=await this.#directory.authorization(member);
      if(!auth?.permissions.includes('computer:use'))computerError('computer_permission_required',403);
      await this.#db.query(`INSERT INTO platform.computer_monitor_grants(computer_id,identity_id,permission,granted_by)
        VALUES($1,$2,$3,$4) ON CONFLICT(computer_id,identity_id) DO UPDATE SET permission=$3,granted_by=$4,updated_at=clock_timestamp()`,[id,member,input.permission,c.ownerId]);
    }
    return this.grants(context,id);
  }
}
