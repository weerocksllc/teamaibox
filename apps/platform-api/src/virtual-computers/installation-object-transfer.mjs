import {createHash} from 'node:crypto';
import {computerError,computerId} from './lifecycle.mjs';
import {inspectInstallationIso} from './inspect-installation-iso.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const scope=ownerId=>({namespaceKey:`user:${computerId(ownerId)}`,context:{identityId:ownerId,identityKind:'local_user',
  namespaceAccess:[{namespaceKey:`user:${ownerId}`,operations:['read','write','delete','list','reference:create']} ]}});
const facts=m=>({objectId:m.objectId,objectVersion:m.version,size:m.size,digest:`sha256:${m.integrity?.digest}`});
function same(m,source){
  if(m.size!==source.size||`sha256:${m.integrity?.digest}`!==source.digest)computerError('computer_media_integrity_mismatch');
  return m;
}

/** Copies only an authorized, fixed drive version. All data stays in existing
 * protected-object storage. Retries recover the same private object key; no
 * host path, public URL, expiring link or in-memory ISO is a persistent source.
 */
export class InstallationObjectTransfer {
  #objects;#gateway;#drive;
  constructor({objectService,teamDrive}){
    if(!['head','list','download','downloadStream','beginMultipart','uploadPart','completeMultipart','abortMultipart',
      'createObjectHandoffGateway'].every(k=>typeof objectService?.[k]==='function')||typeof teamDrive?.download!=='function')
      throw TypeError('Installation media requires protected objects and drive access');
    this.#objects=objectService;this.#gateway=objectService.createObjectHandoffGateway();this.#drive=teamDrive;
  }
  async source({ownerId,input,driveContext}){
    let selected;
    if(input.source==='upload'){
      const grant=await this.#gateway.resolve({actorIdentityId:ownerId,referenceId:input.referenceId,
        audience:'virtual-computer.iso',requiredOperation:'read'});
      // Audience alone is not ownership. The direct owner-scoped head denies
      // references to another namespace, including admin-owned uploads.
      const metadata=await this.#objects.head({...scope(ownerId),objectId:grant.objectId,version:grant.objectVersion});
      if(!metadata.objectKey.startsWith('virtual-computers/installation/'))computerError('computer_media_source_invalid',400);
      selected={kind:'upload',...facts(metadata)};
    }else{
      const ref=await this.#drive.download(driveContext,input.fileId,{version:input.version});
      const metadata=await this.#gateway.head({actorIdentityId:ownerId,referenceId:ref.referenceId,audience:'team-drive.download'});
      selected={kind:'drive',fileId:input.fileId,version:input.version,...facts(metadata)};
    }
    if(!Number.isSafeInteger(selected.size)||selected.size<1||!/^sha256:[a-f0-9]{64}$/.test(selected.digest))
      computerError('computer_media_source_invalid',400);
    return selected;
  }
  async prepare({media,driveContext,signal,onProgress=async()=>{}}){
    const {ownerId,source}=media,owner=scope(ownerId);
    computerId(media.id);signal?.throwIfAborted();
    let metadata;
    if(source.kind==='upload')metadata=same(await this.#objects.head({...owner,objectId:source.objectId,version:source.objectVersion}),source);
    else {
      const objectKey=`virtual-computers/installation-copies/${media.id}/installation.iso`;
      const page=await this.#objects.list({...owner,prefix:objectKey,limit:2});
      metadata=page.items.find(m=>m.objectKey===objectKey);
      if(metadata)same(metadata,source);
      else {
        // Recheck current access before starting a new copy, and request the
        // selected version again instead of following the latest filename.
        const ref=await this.#drive.download(driveContext,source.fileId,{version:source.version});
        const input={actorIdentityId:ownerId,referenceId:ref.referenceId,audience:'team-drive.download'};
        const head=same(await this.#gateway.head(input),source);
        if(head.objectId!==source.objectId||head.version!==source.objectVersion)computerError('computer_media_source_changed');
        const stream=await this.#gateway.downloadStream(input);
        try{metadata=await this.#copy({owner,objectKey,source,chunks:stream.chunks,signal,onProgress});}
        finally{await stream.chunks.return?.();}
      }
    }
    signal?.throwIfAborted();
    const target={...owner,objectId:metadata.objectId,version:metadata.version};
    const inspection=await inspectInstallationIso({size:metadata.size,readRange:async(start,count)=>{
      signal?.throwIfAborted();
      const result=await this.#objects.download({...target,range:{start,endInclusive:start+count-1}});
      same(result.metadata,source);
      if(result.partial!==true)computerError('computer_media_integrity_mismatch');
      return result.content;
    }});
    await onProgress(source.size);
    return {...facts(metadata),compatibility:inspection.compatibility};
  }
  async release(media){
    // No source drive entry is ever deleted. Only the persisted private object
    // selected by the repository is eligible; a failed import has no such ID.
    if(!media.objectId)return;
    const target={...scope(media.ownerId),objectId:media.objectId};
    try{
      const metadata=await this.#objects.head({...target,version:media.objectVersion});
      same(metadata,media);
      if(!metadata.objectKey.startsWith('virtual-computers/installation/')
        &&metadata.objectKey!==`virtual-computers/installation-copies/${media.id}/installation.iso`)
        computerError('computer_media_source_invalid');
      await this.#objects.delete(target);
    }catch(error){if(error.code!=='object_not_found')throw error;}
  }
  async openReady(media,{signal}={}){
    if(media.state!=='ready')computerError('computer_media_not_ready');
    const target={...scope(media.ownerId),objectId:computerId(media.objectId),version:media.objectVersion};
    signal?.throwIfAborted();
    same(await this.#objects.head(target),media);
    const stream=await this.#objects.downloadStream(target);
    // Keep transport buffers bounded even when object backends use larger
    // internal blocks. The immutable private copy, never the drive source, is read.
    return {chunks:(async function*(){try{
      for await(const chunk of stream.chunks){
        signal?.throwIfAborted();
        if(!Buffer.isBuffer(chunk))computerError('computer_media_integrity_mismatch');
        for(let offset=0;offset<chunk.length;offset+=1024**2)yield chunk.subarray(offset,offset+1024**2);
      }
    }finally{await stream.chunks.return?.();}})()};
  }
  async #copy({owner,objectKey,source,chunks,signal,onProgress}){
    signal?.throwIfAborted();
    const upload=await this.#objects.beginMultipart({...owner,objectKey,contentType:'application/x-iso9660-image',
      expectedSize:source.size,expectedSha256:source.digest.slice(7)});
    const buffer=Buffer.alloc(Math.min(16*1024**2,source.size)),digest=createHash('sha256'),parts=[];
    let used=0,total=0,completed=false;
    const flush=async()=>{
      signal?.throwIfAborted();const body=buffer.subarray(0,used),sha256=hash(body),partNumber=parts.length+1;
      await this.#objects.uploadPart({context:owner.context,uploadId:upload.uploadId,partNumber,content:body,expectedSha256:sha256});
      parts.push({partNumber,sha256});used=0;buffer.fill(0);await onProgress(total);
    };
    try{
      for await(const chunk of chunks){
        signal?.throwIfAborted();
        if(!Buffer.isBuffer(chunk)||total+chunk.length>source.size)computerError('computer_media_integrity_mismatch');
        digest.update(chunk);
        for(let offset=0;offset<chunk.length;){
          const count=Math.min(buffer.length-used,chunk.length-offset);chunk.copy(buffer,used,offset,offset+count);
          offset+=count;used+=count;total+=count;if(used===buffer.length)await flush();
        }
      }
      if(total!==source.size||`sha256:${digest.digest('hex')}`!==source.digest)computerError('computer_media_integrity_mismatch');
      if(used)await flush();signal?.throwIfAborted();
      try{
        const result=await this.#objects.completeMultipart({context:owner.context,uploadId:upload.uploadId,parts});
        completed=true;return same(result,source);
      }catch(error){
        // The commit can succeed even if its RPC reply was lost. Do not create
        // another object version on the retry or treat it as missing bytes.
        const page=await this.#objects.list({...owner,prefix:objectKey,limit:2});
        const result=page.items.find(m=>m.objectKey===objectKey);
        if(!result)throw error;
        completed=true;return same(result,source);
      }
    }finally{
      buffer.fill(0);
      if(!completed)await this.#objects.abortMultipart({context:owner.context,uploadId:upload.uploadId}).catch(()=>{});
    }
  }
}
