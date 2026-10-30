import {sha256Blob} from './sha256.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = code => { throw Object.assign(Error(code), {code}); };

/** One ISO transfer journal per owner. No file contents or credentials are
 * persisted. A page close pauses; only explicit cancel aborts server parts.
 * Reselecting a file verifies its full digest before any part is reused.
 */
export function createInstallationUpload({ownerId, storage, fetchImpl=fetch, csrf,
  onProgress=()=>{}, hashBlob=sha256Blob}={}) {
  if (!uuid.test(ownerId??'') || !['getItem','setItem','removeItem'].every(k=>typeof storage?.[k]==='function'))
    throw TypeError('Installation upload requires owner-scoped storage');
  const key=`teamaibox.installation-upload.${ownerId}`;
  let busy=false;
  const read=()=>{const raw=storage.getItem(key);if(!raw)return null;try{return JSON.parse(raw);}catch{fail('computer_upload_journal_invalid');}};
  const save=value=>storage.setItem(key,JSON.stringify(value));
  const valid=s=>s&&s.ownerId===ownerId&&uuid.test(s.uploadId??'')&&typeof s.objectKey==='string'
    &&s.objectKey.startsWith('virtual-computers/installation/')&&/^[a-f0-9]{64}$/.test(s.sha256??'')
    &&Number.isSafeInteger(s.size)&&s.size>0&&Number.isSafeInteger(s.partSize)&&s.partSize>0&&s.partSize<=64*1024**2;
  async function json(path,{method='GET',body,headers={},signal}={}) {
    signal?.throwIfAborted();
    const response=await fetchImpl(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal,
      headers:{accept:'application/json',...(method!=='GET'?{'x-csrf-token':typeof csrf==='function'?csrf():csrf}:{}),
        ...(body!==undefined?{'content-type':body instanceof Blob?'application/octet-stream':'application/json'}:{}),...headers},
      ...(body!==undefined?{body:body instanceof Blob?body:JSON.stringify(body)}:{})});
    const value=await response.json().catch(()=>null);
    if(!response.ok||!value)throw Object.assign(Error(value?.error?.code||'computer_upload_unavailable'),
      {code:value?.error?.code||'computer_upload_unavailable',status:response.status});
    return value;
  }
  async function committed(session,signal) {
    const page=await json('/api/v1/objects?limit=2&prefix='+encodeURIComponent(session.objectKey),{signal});
    const matches=page.data?.filter(o=>o.objectKey===session.objectKey)??[];
    if(matches.length>1)fail('computer_upload_result_mismatch');
    const object=matches[0];
    if(!object)return null;
    if(object.namespaceKey!==`user:${ownerId}`||object.size!==session.size||object.integrity?.digest!==session.sha256)
      fail('computer_upload_result_mismatch');
    const ref=await json(`/api/v1/objects/${object.objectId}/references`,{method:'POST',body:{capability:'virtual_computer'},signal});
    save({...session,phase:'complete',object});
    return {object,...ref};
  }
  return {
    pending:()=>read(),
    async upload(file,{signal}={}) {
      if(busy)fail('computer_upload_pending');
      busy=true;
      try {
        if(!(file instanceof Blob)||file.size<1||!Number.isSafeInteger(file.size))fail('invalid_object_content');
        const sha256=await hashBlob(file,{signal,onProgress:progress=>onProgress({phase:'checking',progress})});
        let session=read();
        if(session) {
          if(!valid(session))fail('computer_upload_journal_invalid');
          if(session.sha256!==sha256||session.size!==file.size)fail('computer_upload_reselect_same_file');
          if(['completing','complete'].includes(session.phase)) {
            const recovered=await committed(session,signal);
            if(recovered)return recovered;
          }
        } else {
          const started=await json('/api/v1/objects/multipart',{method:'POST',signal,body:{capability:'virtual_computer',
            name:file.name||'installation.iso',media_type:'application/x-iso9660-image',size:file.size,sha256}});
          session={ownerId,uploadId:started.upload?.uploadId,objectKey:started.upload?.objectKey,
            size:file.size,sha256,partSize:started.part_size_bytes,phase:'uploading'};
          if(!valid(session))fail('computer_upload_result_mismatch');
          save(session);
        }
        const path='/api/v1/objects/multipart/'+session.uploadId;
        let listed;
        try {listed=await json(path+'/parts',{signal});}
        catch(error) {
          // Completion can commit and lose its reply. Resolve the exact saved
          // object key before treating a missing upload as an expired transfer.
          if(error.code==='upload_not_found') {
            const recovered=await committed(session,signal);
            if(recovered)return recovered;
          }
          throw error;
        }
        if(!Array.isArray(listed.data))fail('computer_upload_result_mismatch');
        const stored=new Map(listed.data.map(p=>[p.partNumber,p]));
        if(stored.size!==listed.data.length)fail('computer_upload_result_mismatch');
        const parts=[];
        for(let offset=0;offset<file.size;offset+=session.partSize) {
          const part=file.slice(offset,offset+session.partSize),partNumber=parts.length+1;
          const digest=await hashBlob(part,{signal}),old=stored.get(partNumber);
          if(old&&(old.size!==part.size||old.integrity?.digest!==digest))fail('computer_upload_part_mismatch');
          if(!old)await json(path+'/parts/'+partNumber,{method:'PUT',body:part,signal,headers:{'x-content-sha256':digest}});
          stored.delete(partNumber);parts.push({part_number:partNumber,sha256:digest});
          onProgress({phase:'uploading',progress:Math.min(1,(offset+part.size)/file.size)});
        }
        if(stored.size)fail('computer_upload_part_mismatch');
        save({...session,phase:'completing'});
        onProgress({phase:'preparing',progress:1});
        await json(path,{method:'POST',body:{parts},signal});
        const result=await committed(session,signal);
        if(!result)fail('computer_upload_result_mismatch');
        return result;
      } finally {busy=false;}
    },
    async cancel() {
      if(busy)fail('computer_upload_pending');
      busy=true;
      try {
        const session=read();if(!session)return {cancelled:true};
        if(!valid(session))fail('computer_upload_journal_invalid');
        if(session.phase==='complete')return {cancelled:false,complete:true};
        if(session.phase==='completing'&&await committed(session))return {cancelled:false,complete:true};
        await json('/api/v1/objects/multipart/'+session.uploadId,{method:'DELETE'});
        storage.removeItem(key);return {cancelled:true};
      } finally {busy=false;}
    },
    acknowledgeImport() {
      if(busy||read()?.phase!=='complete')fail('computer_upload_pending');
      storage.removeItem(key);
    },
  };
}
