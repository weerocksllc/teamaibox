import {computerError,computerId,requestKey} from './lifecycle.mjs';
import {mediaImportInput} from './installation-media.mjs';

export const publicInstallationMedia=m=>({id:m.id,name:m.name,state:m.state,revision:m.revision,
  source:m.source.kind,size:m.size??m.source.size,copiedBytes:m.copiedBytes,
  compatibility:m.compatibility,errorCode:m.errorCode??null});
export async function installationOwner(directory,ownerId){
  const id=computerId(ownerId),auth=await directory.authorization(id);
  if(!auth?.permissions?.includes('computer:use'))computerError('computer_permission_required',403);
  return {actorIdentityId:id,permissions:auth.permissions,teamRoles:Object.fromEntries((auth.teamMemberships??[])
    .map(m=>[m.teamKey,m.roleKey==='team_admin'?'manager':m.roleKey]))};
}
export class InstallationMediaService {
  #repository;#directory;#transfer;
  constructor({repository,directory,transfer}){this.#repository=repository;this.#directory=directory;this.#transfer=transfer;}
  async #owner(context){
    if(!context?.identityId)computerError('invalid_session',401);
    return installationOwner(this.#directory,context.identityId);
  }
  async list({context}){
    const c=await this.#owner(context);return {data:(await this.#repository.list(c.actorIdentityId)).map(publicInstallationMedia)};
  }
  async get({context,mediaId}){
    const c=await this.#owner(context);return publicInstallationMedia(await this.#repository.get(c.actorIdentityId,mediaId));
  }
  async create({context,input,key}){
    const c=await this.#owner(context),request=mediaImportInput(input);requestKey(key);
    const prior=await this.#repository.findRequest(c.actorIdentityId,key,request);
    if(prior)return publicInstallationMedia(prior);
    const source=await this.#transfer.source({ownerId:c.actorIdentityId,input:request,driveContext:c});
    return publicInstallationMedia(await this.#repository.create({ownerId:c.actorIdentityId,key,input:request,source}));
  }
  async remove({context,mediaId,input}){
    const c=await this.#owner(context);
    if(!input||Object.keys(input).some(k=>!['expectedRevision','confirmDelete'].includes(k))||input.confirmDelete!==true
      ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)computerError('computer_input_invalid',400);
    return publicInstallationMedia(await this.#repository.remove(c.actorIdentityId,mediaId,input.expectedRevision));
  }
}
