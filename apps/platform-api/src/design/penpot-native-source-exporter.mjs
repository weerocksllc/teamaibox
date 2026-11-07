import { PlatformError } from '../../../../packages/observability/src/index.mjs';

const UUID_PATTERN='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID=new RegExp('^'+UUID_PATTERN+'$','i');
const ASSET=new RegExp('^/assets/by-id/'+UUID_PATTERN+'$','i');
const unavailable=()=>new PlatformError('penpot_drive_export_unavailable','The native design export is unavailable',{status:503});
const changed=()=>new PlatformError('penpot_drive_export_source_changed','The saved design changed; select the new version before exporting',{status:409});

function origin(value) {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new TypeError('Invalid native export origin');
  return url;
}
async function body(response,limit){
  if(!response.ok||!response.body){await response.body?.cancel();throw unavailable();}
  const parts=[];let size=0;
  for await(const part of response.body){
    size+=part.length;if(size>limit)throw unavailable();
    parts.push(part);
  }
  return Buffer.concat(parts,size);
}
const key=version=>JSON.stringify([version.revision,version.documentVersion,version.modifiedAt]);

/** Read an actual native .penpot archive. The target path must come from the
 * native SSE end event and is still resolved against the fixed frontend. */
export class PenpotNativeSourceExporter {
  #backend;#frontend;#permissions;#fetch;#baseline=new WeakMap();
  constructor({backendOrigin,frontendOrigin,nativePermissions,fetchImplementation=fetch}){
    if(!nativePermissions?.savedRevision)throw new TypeError('Native version authority is required');
    this.#backend=origin(backendOrigin);this.#frontend=origin(frontendOrigin);
    this.#permissions=nativePermissions;this.#fetch=fetchImplementation;
  }
  async revision(nativeContext,{fileId,pageId}){
    const {profileId}=await nativeContext.assertCurrent();
    return this.#permissions.savedRevision({profileId,fileId,pageId});
  }
  async frames(nativeContext,source){
    const {nativeToken}=await nativeContext.assertCurrent();
    const reply=await this.#fetch(new URL('/api/main/methods/get-page',this.#backend),{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
      headers:{cookie:'auth-token='+nativeToken,accept:'application/json','content-type':'application/json'},
      body:JSON.stringify({'file-id':source.fileId,'page-id':source.pageId}),
    }).catch(()=>{throw unavailable();});
    const data=JSON.parse((await body(reply,16*1024*1024)).toString('utf8'));
    if(data?.id!==source.pageId||!data.objects||typeof data.objects!=='object'||Array.isArray(data.objects))throw unavailable();
    return Object.values(data.objects).filter(shape=>shape?.type==='frame'&&UUID.test(shape.id??'')&&typeof shape.name==='string')
      .slice(0,500).map(shape=>({id:shape.id,name:shape.name.slice(0,250)}));
  }
  async checkSaved({nativeContext,source}){
    const saved=await this.revision(nativeContext,source);
    if(saved.revision!==source.revision||(source.documentVersion!==undefined&&saved.documentVersion!==source.documentVersion)
      ||(this.#baseline.has(nativeContext)&&this.#baseline.get(nativeContext)!==key(saved)))throw changed();
    return saved;
  }
  async exportSaved({nativeContext,source,signal}){
    if(!['penpot','png','pdf'].includes(source.format))throw new PlatformError('penpot_drive_export_format_unavailable','This format is not available for Drive export',{status:415});
    this.#baseline.set(nativeContext,key(await this.checkSaved({nativeContext,source})));
    const {nativeToken,profileId}=await nativeContext.assertCurrent();
    const cookie='auth-token='+nativeToken;
    const abort=AbortSignal.timeout(45_000);
    const requestSignal=signal?AbortSignal.any([signal,abort]):abort;
    let uri;
    if(source.format!=='penpot'){
      if(!(await this.frames(nativeContext,source)).some(frame=>frame.id===source.objectId))throw changed();
      await this.checkSaved({nativeContext,source});
      const exportBody=['^ ','~:cmd','~:export-shapes','~:profile-id','~u'+profileId,'~:wait',true,
        '~:exports',[['^ ','~:file-id','~u'+source.fileId,'~:page-id','~u'+source.pageId,'~:object-id','~u'+source.objectId,
          '~:type','~:'+source.format,'~:suffix','','~:scale',1,'~:name','Design']]];
      const reply=await this.#fetch(new URL('/api/export',this.#frontend),{
        method:'POST',redirect:'error',signal:requestSignal,headers:{cookie,'x-teamaibox-export-profile':profileId,
          'content-type':'application/transit+json',accept:'application/transit+json'},body:JSON.stringify(exportBody),
      }).catch(()=>{throw unavailable();});
      if(!reply.headers.get('content-type')?.startsWith('application/transit+json')){await reply.body?.cancel();throw unavailable();}
      const exported=JSON.parse((await body(reply,64*1024)).toString('utf8'));
      uri=exported?.['~:uri']?.['~#uri'];
    }else{
    const reply=await this.#fetch(new URL('/api/main/methods/export-binfile',this.#backend),{
      method:'POST',redirect:'error',signal:requestSignal,headers:{cookie,accept:'text/event-stream','content-type':'application/json'},
      body:JSON.stringify({'file-id':source.fileId,'include-libraries':false,'embed-assets':true}),
    }).catch(()=>{throw unavailable();});
    if(!reply.headers.get('content-type')?.startsWith('text/event-stream')){await reply.body?.cancel();throw unavailable();}
    const events=(await body(reply,1024*1024)).toString('utf8');
    const ended=events.split(/\r?\n\r?\n/).filter(event=>/^event: end\r?\n/.test(event));
    if(ended.length!==1||events.split(/\r?\n/).includes('event: error'))throw unavailable();
    try{
      const serialized=ended[0].split(/\r?\n/).find(line=>line.startsWith('data: '))?.slice(6);
      const value=JSON.parse(serialized);
      // Pinned Penpot's Transit verbose encoder tags java.net.URI.
      if(!value||Object.keys(value).length!==1||typeof value['~#uri']!=='string')throw unavailable();
      uri=value['~#uri'];
    }catch{throw unavailable();}
    }
    let asset;
    try{asset=new URL(uri);}catch{throw unavailable();}
    if(asset.origin!==this.#frontend.origin||!ASSET.test(asset.pathname)||asset.search||asset.hash||asset.username||asset.password)throw unavailable();
    await this.checkSaved({nativeContext,source});
    const file=await this.#fetch(new URL(asset.pathname,this.#frontend),{redirect:'error',signal:requestSignal,headers:{cookie}})
      .catch(()=>{throw unavailable();});
    const bytes=await body(file,32*1024*1024);
    await this.checkSaved({nativeContext,source});
    return {...source,bytes};
  }
}
