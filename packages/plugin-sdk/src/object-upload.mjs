import {sha256Blob} from './sha256.mjs';

// All applications use the same bounded-memory transfer. Part size is a wire
// buffer, not a maximum file size. Storage admission remains server-owned.
export async function uploadObject(file,{capability,mediaType=file?.type||'application/octet-stream',
  csrf,signal,fetchImpl=fetch,onProgress=()=>{}}={}) {
  if(!(file instanceof Blob)||!Number.isSafeInteger(file.size)||file.size<1)throw Error('invalid_object_content');
  const json=async(path,{method='POST',body,headers={},signal:requestSignal=signal}={})=>{
    requestSignal?.throwIfAborted();
    const response=await fetchImpl(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:requestSignal,
      headers:{accept:'application/json','x-csrf-token':typeof csrf==='function'?csrf():csrf,
        'content-type':body instanceof Blob?'application/octet-stream':'application/json',...headers},
      body:body instanceof Blob?body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json().catch(()=>null);
    if(!response.ok||!value){const error=Error(value?.error?.message||'File transfer failed');error.code=value?.error?.code;throw error;}
    return value;
  };
  const sha256=await sha256Blob(file,{signal,onProgress:progress=>onProgress({phase:'checking',progress})});
  let uploadId,complete=false;
  try{
    const start=await json('/api/v1/objects/multipart',{body:{capability,name:file.name||'upload',media_type:mediaType,size:file.size,sha256}});
    uploadId=start?.upload?.uploadId;
    if(!/^[0-9a-f-]{36}$/i.test(uploadId??''))throw Error('invalid_upload_response');
    const partSize=start.part_size_bytes;
    if(!Number.isSafeInteger(partSize)||partSize<1||partSize>64*1024**2)throw Error('invalid_upload_response');
    const parts=[];
    for(let offset=0;offset<file.size;offset+=partSize){
      signal?.throwIfAborted();const part=file.slice(offset,offset+partSize),digest=await sha256Blob(part,{signal});
      const partNumber=parts.length+1;
      await json(`/api/v1/objects/multipart/${uploadId}/parts/${partNumber}`,{method:'PUT',body:part,headers:{'x-content-sha256':digest}});
      parts.push({part_number:partNumber,sha256:digest});onProgress({phase:'uploading',progress:Math.min(1,(offset+partSize)/file.size)});
    }
    const value=await json('/api/v1/objects/multipart/'+uploadId,{body:{parts}});
    complete=true;
    if(value.object?.size!==file.size||value.object?.integrity?.digest!==sha256)throw Error('invalid_upload_response');
    return value;
  }finally{
    if(uploadId&&!complete)await json('/api/v1/objects/multipart/'+uploadId,{method:'DELETE',signal:AbortSignal.timeout(5000)}).catch(()=>{});
  }
}
