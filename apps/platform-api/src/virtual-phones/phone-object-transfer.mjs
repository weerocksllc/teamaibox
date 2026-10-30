import {createHash,randomUUID} from 'node:crypto';
import {failPhone,identifier,integer,record,PHONE_POLICY} from './contracts.mjs';

const PART=4*1024**2,CHUNK=64*1024;
export function phoneTransferName(value){
  if(typeof value!=='string'||!value.trim()||value!==value.trim()||Buffer.byteLength(value)>240
    || value==='.'||value==='..'||value.startsWith('.transfer-')||/[\\/\p{Cc}\p{Cf}]/u.test(value))failPhone('phone_input_invalid');
  return value.normalize('NFC');
}
export function phoneTransferInput(input,maximumBytes=PHONE_POLICY.maximumUploadBytes){
  record(input,['objectId','objectVersion','name','sizeBytes','sha256']);
  if(!Number.isSafeInteger(input.sizeBytes)||input.sizeBytes<1)failPhone('phone_input_invalid');
  if(input.sizeBytes>maximumBytes)failPhone('phone_upload_too_large');
  if(!/^[a-f0-9]{64}$/.test(input.sha256??''))failPhone('phone_object_invalid');
  return {objectId:identifier(input.objectId),objectVersion:integer(input.objectVersion,1,Number.MAX_SAFE_INTEGER),
    name:phoneTransferName(input.name),sizeBytes:input.sizeBytes,sha256:input.sha256};
}
function objectContext(ownerId){
  const namespaceKey=`user:${identifier(ownerId)}`;
  return {namespaceKey,context:{identityId:ownerId,identityKind:'local_user',namespaceAccess:[{namespaceKey,
    operations:['read','write','delete','reference:create']}]}};
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Content adapter only. Callers must authorize the selected phone/current run
 * before invoking it. It reuses ProtectedObjectService, not a second disk store.
 * No caller-selected namespace/host URL/path or plaintext filesystem staging.
 */
export class PhoneObjectTransfer {
  #objects;#maximum;#busy=new Set();
  constructor({objectService,maximumBytes=PHONE_POLICY.maximumUploadBytes}){
    if(!['download','beginMultipart','uploadPart','completeMultipart','abortMultipart'].every(key=>typeof objectService?.[key]==='function'))throw TypeError('Phone object transfer dependencies missing');
    this.#objects=objectService;this.#maximum=integer(maximumBytes,1,PHONE_POLICY.maximumUploadBytes);
  }
  async #head(target){
    if(typeof this.#objects.head==='function')return this.#objects.head(target);
    // The deployed protected-object RPC already supports authorized ranges,
    // but not a direct head method. Read one byte for metadata before fetching
    // the bounded file; never fetch an unverified full object as a fallback.
    const part=await this.#objects.download({...target,range:{start:0,endInclusive:0}});
    try {
      if(part.partial!==true || !Buffer.isBuffer(part.content) || part.content.length!==1)failPhone('phone_object_invalid');
      return part.metadata;
    } finally {part.content?.fill?.(0);}
  }
  async #slot(ownerId,action){
    identifier(ownerId);if(this.#busy.has(ownerId))failPhone('phone_operation_conflict');
    this.#busy.add(ownerId);try{return await action();}finally{this.#busy.delete(ownerId);}
  }
  async withInput({ownerId,input,signal},consume){
    if(typeof consume!=='function')throw TypeError('Phone input consumer missing');
    const selected=phoneTransferInput(input,this.#maximum),scope=objectContext(ownerId);
    return this.#slot(ownerId,async()=>{
      signal?.throwIfAborted();
      const target={...scope,objectId:selected.objectId,version:selected.objectVersion};
      let head;
      try{head=await this.#head(target);}catch{failPhone('phone_object_invalid');}
      if(head.objectId!==selected.objectId||head.version!==selected.objectVersion||head.namespaceKey!==scope.namespaceKey
        ||head.size!==selected.sizeBytes||head.integrity?.digest!==selected.sha256)failPhone('phone_object_invalid');
      signal?.throwIfAborted();
      if(typeof this.#objects.downloadStream==='function') {
        const loaded=await this.#objects.downloadStream({...target,signal});
        const hash=createHash('sha256');let total=0,consumed=false;
        const chunks=(async function*(){
          for await(const chunk of loaded.chunks){
            signal?.throwIfAborted();total+=chunk.length;
            if(total>selected.sizeBytes)failPhone('phone_object_invalid');hash.update(chunk);
            for(let offset=0;offset<chunk.length;offset+=CHUNK)yield chunk.subarray(offset,offset+CHUNK);
          }
          if(total!==selected.sizeBytes||hash.digest('hex')!==selected.sha256)failPhone('phone_object_invalid');
          consumed=true;
        })();
        try{const result=await consume({metadata:Object.freeze(selected),chunks});
          signal?.throwIfAborted();if(!consumed)failPhone('phone_object_invalid');return result;
        }finally{await chunks.return();await loaded.chunks.return?.();}
      }
      const loaded=await this.#objects.download(target),content=loaded.content;
      try{
        signal?.throwIfAborted();
        if(!Buffer.isBuffer(content)||content.length!==selected.sizeBytes||digest(content)!==selected.sha256)failPhone('phone_object_invalid');
        let consumed=false;
        const chunks=async function*(){for(let offset=0;offset<content.length;offset+=CHUNK){signal?.throwIfAborted();yield content.subarray(offset,offset+CHUNK);}consumed=true;};
        // The existing object service verifies/decrypts one bounded object;
        // avoid re-decrypting it for every network chunk. At most two transfers
        // run in this process. The buffer is wiped on success/error/cancel.
        const result=await consume({metadata:Object.freeze(selected),chunks:chunks()});
        signal?.throwIfAborted();
        if(!consumed)failPhone('phone_object_invalid');
        return result;
      }finally{content?.fill?.(0);}
    });
  }
  async storeOutput({ownerId,phoneId,name,sizeBytes,sha256,chunks,signal}){
    identifier(phoneId);phoneTransferInput({objectId:phoneId,objectVersion:1,name,sizeBytes,sha256},this.#maximum);
    if(!chunks?.[Symbol.asyncIterator])failPhone('phone_input_invalid');
    const scope=objectContext(ownerId);
    return this.#slot(ownerId,async()=>{
      signal?.throwIfAborted();
      const upload=await this.#objects.beginMultipart({...scope,objectKey:`virtual-phones/${phoneId}/exports/${randomUUID()}/${phoneTransferName(name)}`,
        contentType:'application/octet-stream',expectedSize:sizeBytes,expectedSha256:sha256});
      const buffer=Buffer.alloc(Math.min(PART,sizeBytes)),hash=createHash('sha256'),parts=[];
      let used=0,total=0,complete=false;
      const flush=async()=>{
        signal?.throwIfAborted();const body=buffer.subarray(0,used),checksum=digest(body),partNumber=parts.length+1;
        await this.#objects.uploadPart({context:scope.context,uploadId:upload.uploadId,partNumber,content:body,expectedSha256:checksum});
        parts.push({partNumber,sha256:checksum});buffer.fill(0);used=0;
      };
      try{
        for await(const chunk of chunks){
          signal?.throwIfAborted();
          if(!Buffer.isBuffer(chunk)||chunk.length>1024**2)failPhone('phone_object_invalid');
          total+=chunk.length;if(total>this.#maximum||total>sizeBytes)failPhone('phone_upload_too_large');
          hash.update(chunk);
          for(let offset=0;offset<chunk.length;){const count=Math.min(buffer.length-used,chunk.length-offset);chunk.copy(buffer,used,offset,offset+count);used+=count;offset+=count;if(used===buffer.length)await flush();}
        }
        if(total!==sizeBytes||hash.digest('hex')!==sha256)failPhone('phone_object_invalid');
        if(used)await flush();signal?.throwIfAborted();
        const object=await this.#objects.completeMultipart({context:scope.context,uploadId:upload.uploadId,parts});complete=true;
        return object;
      }finally{
        buffer.fill(0);
        if(!complete)await this.#objects.abortMultipart({context:scope.context,uploadId:upload.uploadId});
      }
    });
  }
}
