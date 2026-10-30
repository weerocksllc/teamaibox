import {validateAndroidPhoneCommand} from './android-phone-command.mjs';
import {bufferedMediaBytes} from '../../object-service/src/buffered-media-budget.mjs';

export const PHONE_FILE_END=Buffer.from('\nTEAMAIBOX-FILE-END\n');
export const PHONE_FILE_MAXIMUM=Number.MAX_SAFE_INTEGER;
const base=['phoneId','ownerId','volumeId','poolId','baseBuildId','operationId','generation','run'];
export function validatePhoneFileCommand(value,{now=Date.now()}={}) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw TypeError('Invalid phone file command');
  const action=value.action,extras=action==='upload'||action==='install'?['name','sizeBytes','sha256']:action==='download'?['name']:[];
  const fields=[...base,'action','deadline',...extras];
  if(!['upload','install','download','list'].includes(action)||Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k))
    ||!Number.isSafeInteger(value.deadline)||value.deadline<=now||value.deadline>now+120000)throw TypeError('Invalid phone file command');
  validateAndroidPhoneCommand('inspect',Object.fromEntries(base.map(k=>[k,value[k]])));
  if(extras.includes('name') && (typeof value.name!=='string'||!value.name.length||value.name!==value.name.trim()||Buffer.byteLength(value.name)>240
    ||value.name!==value.name.normalize('NFC')||value.name==='.'||value.name==='..'||value.name.startsWith('.transfer-')||/[\\/\p{Cc}\p{Cf}]/u.test(value.name)))throw TypeError('Invalid phone file name');
  if(extras.includes('sizeBytes') && (!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<1||value.sizeBytes>PHONE_FILE_MAXIMUM||!/^[a-f0-9]{64}$/.test(value.sha256??'')))throw TypeError('Invalid phone file size or checksum');
  return Object.freeze(structuredClone(value));
}

/** Decode an exact worker response without buffering a whole download. */
export async function readPhoneFileResponse(response,payload,{progress=()=>{}}={}) {
  const iterator=response[Symbol.asyncIterator]();let pending=Buffer.alloc(0);
  const next=async()=>{const value=await iterator.next();if(value.done)return null;if(!Buffer.isBuffer(value.value)||value.value.length>1024**2)throw Error('phone_file_response_invalid');progress();return value.value;};
  let value;
  try {
    do {
      let index;
      const maximum=payload.action==='list'?bufferedMediaBytes():65536;
      while((index=pending.indexOf(10))<0) {const chunk=await next();if(!chunk)throw Error('phone_file_response_missing');pending=Buffer.concat([pending,chunk]);if(pending.indexOf(10)<0&&pending.length>maximum)throw Error('phone_file_response_invalid');}
      if(index>maximum)throw Error('phone_file_response_invalid');
      try{value=JSON.parse(pending.subarray(0,index).toString('utf8'));}catch{throw Error('phone_file_response_invalid');}
      pending=pending.subarray(index+1);
      if(value?.errorCode)throw Error(['phone_install_failed','phone_object_invalid','phone_upload_too_large','phone_stale_run','phone_storage_full','phone_operation_conflict'].includes(value.errorCode)?value.errorCode:'phone_file_transfer_rejected');
      if(value?.phoneId!==payload.phoneId||value.runId!==payload.run.id||value.generation!==payload.generation||value.transferId!==payload.operationId)throw Error('phone_stale_run');
      if(Object.hasOwn(value,'progress') && (value.progress!==true||Object.keys(value).length!==5))throw Error('phone_file_response_invalid');
    } while(value.progress===true);
  } catch(error) {response.destroy?.();await iterator.return?.();throw error;}
  if(payload.action!=='download') {
    if(pending.length||await next()!==null)throw Error('phone_file_response_invalid');
    return value;
  }
  if(value.name!==payload.name||!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<1||value.sizeBytes>PHONE_FILE_MAXIMUM||!/^[a-f0-9]{64}$/.test(value.sha256??''))throw Error('phone_file_response_invalid');
  const chunks=async function*(){
    let remaining=value.sizeBytes;
    try {
      while(remaining){if(!pending.length){pending=await next();if(!pending)throw Error('phone_file_response_truncated');}
        const size=Math.min(remaining,pending.length,65536),chunk=pending.subarray(0,size);pending=pending.subarray(size);remaining-=size;yield chunk;}
      while(pending.length<PHONE_FILE_END.length){const chunk=await next();if(!chunk)throw Error('phone_file_response_truncated');pending=Buffer.concat([pending,chunk]);}
      if(!pending.equals(PHONE_FILE_END)||await next()!==null)throw Error('phone_file_response_invalid');
    }finally {response.destroy?.();await iterator.return?.();}
  };
  return {...value,chunks:chunks()};
}
