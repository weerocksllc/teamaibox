import {computerError} from './lifecycle.mjs';
const ROOT='/api/v1/virtual-computers';
const ID='([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})';
const COMPUTER=new RegExp(`^${ROOT}/${ID}$`,'i');
const ACTION=new RegExp(`^${ROOT}/${ID}/(start|shutdown)$`,'i');
const OPERATION=new RegExp(`^${ROOT}/operations/${ID}$`,'i');
const MEDIA_ROOT=`${ROOT}/installation-media`;
const MEDIA=new RegExp(`^${MEDIA_ROOT}/${ID}$`,'i');
const INSTALLATION=new RegExp(`^${ROOT}/${ID}/installation$`,'i');
const INSTALLATION_ACTION=new RegExp(`^${ROOT}/${ID}/installation/(mount|eject|boot-disc|cancel-boot|installed|adopt)$`,'i');
const ADMIN='/api/v1/admin/virtual-computers';
const QUOTA=new RegExp(`^${ADMIN}/quotas/${ID}$`,'i');
const PROFILE=new RegExp(`^${ADMIN}/systems/([a-z0-9][a-z0-9._-]*)$`);
export class VirtualComputerHttpApi {
  #service;#media;
  constructor({service,mediaService=null}) {
    if(!['availability','list','get','getOperation','create','action'].every(k=>typeof service?.[k]==='function'))throw TypeError('Computer HTTP service incomplete');
    this.#service=service;this.#media=mediaService;
  }
  matches(method,path) {
    return this.#media&&(path===MEDIA_ROOT&&['GET','POST'].includes(method)||MEDIA.test(path)&&['GET','DELETE'].includes(method))
      ||this.#media&&(INSTALLATION.test(path)&&method==='GET'||INSTALLATION_ACTION.test(path)&&method==='POST')
      ||path===ADMIN&&method==='GET'||path===`${ADMIN}/policy`&&method==='PUT'
      ||path===`${ADMIN}/quotas`&&method==='GET'||QUOTA.test(path)&&method==='PUT'
      ||path===`${ADMIN}/systems`&&method==='PUT'||PROFILE.test(path)&&method==='PUT'
      ||path===ROOT&&['GET','POST'].includes(method)
      ||path===`${ROOT}/availability`&&method==='GET'
      ||COMPUTER.test(path)&&['GET','DELETE'].includes(method)
      ||ACTION.test(path)&&method==='POST'||OPERATION.test(path)&&method==='GET';
  }
  async handle({method,pathname,context,body,headers={},query={}}) {
    if(!this.matches(method,pathname))computerError('not_found',404);
    if(pathname===`${ADMIN}/quotas`)return {status:200,body:await this.#service.administrationQuotas({context,query}),headers:{'cache-control':'no-store'}};
    if((query instanceof URLSearchParams?[...query.keys()]:Object.keys(query)).length)computerError('computer_input_invalid',400);
    const args={context,input:body,key:headers['idempotency-key']};
    let value;
    if(pathname===MEDIA_ROOT)value=await this.#media[method==='GET'?'list':'create'](args);
    else if(MEDIA.test(pathname))value=await this.#media[method==='GET'?'get':'remove']({...args,mediaId:MEDIA.exec(pathname)[1]});
    else if(INSTALLATION.test(pathname))value=await this.#service.installation({...args,computerId:INSTALLATION.exec(pathname)[1]});
    else if(INSTALLATION_ACTION.test(pathname)){
      const match=INSTALLATION_ACTION.exec(pathname);value=await this.#service.installationAction({...args,computerId:match[1],action:match[2]});
    }
    else if(pathname===ADMIN)value=await this.#service.administration(args);
    else if(pathname===`${ADMIN}/policy`)value=await this.#service.setPolicy(args);
    else if(pathname===`${ADMIN}/systems`)value=await this.#service.importProfile(args);
    else if(PROFILE.test(pathname))value=await this.#service.publishProfile({...args,profileId:PROFILE.exec(pathname)[1]});
    else if(QUOTA.test(pathname))value=await this.#service.setQuota({...args,ownerId:QUOTA.exec(pathname)[1]});
    else if(pathname===`${ROOT}/availability`)value=await this.#service.availability(args);
    else if(pathname===ROOT)value=await this.#service[method==='GET'?'list':'create'](args);
    else if(OPERATION.test(pathname))value=await this.#service.getOperation({...args,operationId:OPERATION.exec(pathname)[1]});
    else if(ACTION.test(pathname)) {
      const match=ACTION.exec(pathname);value=await this.#service.action({...args,computerId:match[1],action:match[2]});
    } else {
      const id=COMPUTER.exec(pathname)[1];value=await this.#service[method==='GET'?'get':'action']({...args,computerId:id,action:'delete'});
    }
    return {status:method==='GET'||method==='PUT'?200:202,body:value,headers:{'cache-control':'no-store'}};
  }
}
