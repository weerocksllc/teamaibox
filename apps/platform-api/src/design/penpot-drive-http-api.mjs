import { PlatformError } from '../../../../packages/observability/src/index.mjs';

const PREFIX='/api/v1/design/editor/_integration/drive/';
const REVISION=PREFIX+'revision', EXPORT=PREFIX+'export', IMPORT=PREFIX+'import', IMAGE=PREFIX+'image';
const invalid=(status=400)=>new PlatformError('penpot_drive_request_invalid','Invalid design transfer request',{status});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function input(request){
  if(request.method!=='POST')throw invalid(405);
  if(request.headers['content-type']?.split(';')[0]!=='application/json')throw invalid(415);
  const parts=[];let size=0;
  for await(const chunk of request){
    size+=chunk.length;if(size>4096)throw invalid(413);parts.push(chunk);
  }
  let value;
  try{value=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw invalid();}
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
  return value;
}

export class PenpotDriveHttpApi {
  #authority;#native;#output;#importer;#input;#permissions;
  constructor({authority,nativeExporter,output,importer=null,driveInput=null,nativePermissions=null}){
    if(!authority?.authenticateNativeSession||!nativeExporter?.revision||!output?.save)throw new TypeError('Design Drive authority required');
    if(importer&&!importer.run)throw new TypeError('Design import authority required');
    this.#authority=authority;this.#native=nativeExporter;this.#output=output;this.#importer=importer;
    this.#input=driveInput;this.#permissions=nativePermissions;
  }
  matches(path){return [REVISION,EXPORT].includes(path)||path===IMPORT&&this.#importer!==null
    ||path===IMAGE&&!!this.#input&&!!this.#permissions;}
  async handle({request,response,authenticate,nativeToken}){
    const context=await authenticate({csrf:true});
    const assertCurrent=async()=>{
      const current=await authenticate({csrf:true});
      if(current.identityId!==context.identityId||current.sessionId!==context.sessionId)throw invalid(403);
      const native=await this.#authority.authenticateNativeSession({context:current,nativeToken});
      return {...native,nativeToken,context:current};
    };
    const nativeContext={assertCurrent};
    const currentActor=async()=>{
      const {context:live}=await assertCurrent();
      return {actorIdentityId:live.identityId,permissions:live.permissions,teamRoles:live.teamRoles??{}};
    };
    await assertCurrent();
    const body=await input(request);
    let result;
    if(request.url===REVISION){
      if(!UUID.test(body.fileId??'')||!UUID.test(body.pageId??'')||Object.keys(body).some(key=>!['fileId','pageId','includeFrames'].includes(key))
        ||(body.includeFrames!==undefined&&typeof body.includeFrames!=='boolean'))throw invalid();
      result=await this.#native.revision(nativeContext,body);
      if(body.includeFrames){
        const frames=await this.#native.frames(nativeContext,body);
        const after=await this.#native.revision(nativeContext,body);
        if(JSON.stringify(result)!==JSON.stringify(after))throw invalid(409);
        result={...result,frames};
      }
    }else if(request.url===IMAGE){
      const {fileId,pageId,source,format}=body;
      if(Object.keys(body).some(key=>!['fileId','pageId','source','format'].includes(key))
        ||!UUID.test(fileId??'')||!UUID.test(pageId??'')||!['image/png','image/jpeg','image/webp'].includes(format))throw invalid();
      const canEdit=async()=>{
        const {profileId}=await assertCurrent();
        if((await this.#permissions.check({profileId,fileId,pageId})).canEdit!==true)throw invalid(403);
      };
      const abort=new AbortController();
      const cancel=()=>abort.abort();
      response.once('close',cancel);
      let staged;
      try{
        await canEdit();
        staged=await this.#input.read({fileId:source?.fileId,version:source?.version,format,currentActor,signal:abort.signal});
        await canEdit();
        await staged.recheck();
        if(response.destroyed)return;
        // Do not zero the shared byte buffer until Node has flushed or closed it.
        const release=staged.release;
        response.once('close',release);
        response.writeHead(200,{'content-type':format,'content-length':staged.content.length,
          'cache-control':'no-store','x-content-type-options':'nosniff'});
        response.end(staged.content,release);
        staged=null;
        return;
      }finally{response.off('close',cancel);staged?.release();}
    }else{
      const importing=request.url===IMPORT;
      if(importing
        ? !this.#importer||Object.keys(body).some(key=>!['operationId','source','projectId','observeOnly'].includes(key))
        : Object.keys(body).some(key=>!['operationId','source','target','observeOnly'].includes(key))
          ||!Number.isSafeInteger(body.source?.documentVersion)||body.source.documentVersion<0)throw invalid();
      if(body.observeOnly!==undefined&&typeof body.observeOnly!=='boolean')throw invalid();
      const abort=new AbortController();
      const cancel=()=>{if(!response.writableEnded)abort.abort();};
      response.once('close',cancel);
      try{
        const args={...body,nativeContext,signal:abort.signal,currentActor};
        result=importing?await this.#importer.run(args):await this.#output.save(args);
      }finally{response.off('close',cancel);}
    }
    if(response.destroyed)return;
    response.writeHead(result.state==='pending_confirmation'?202:200,{'content-type':'application/json','cache-control':'no-store'});
    response.end(JSON.stringify(result));
  }
}
