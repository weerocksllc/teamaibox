import {freemem} from 'node:os';
import {getHeapStatistics} from 'node:v8';
import {constants} from 'node:buffer';
import {readFileSync} from 'node:fs';
import {PlatformError} from '../../../packages/observability/src/index.mjs';

const accounts=new WeakMap();
export function createBufferedMediaAccount(){const account=Object.freeze({});accounts.set(account,0);return account;}
const defaultAccount=createBufferedMediaAccount();
function held(account){if(!accounts.has(account))throw new TypeError('Invalid buffer memory account');return accounts.get(account);}
export function cgroupMediaHeadroom(maximum,current,stat='') {
  const values=Object.fromEntries(stat.trim().split('\n').map(line=>line.trim().split(/\s+/)).map(([key,value])=>[key,Number(value)]));
  const counter=key=>Number.isSafeInteger(values[key])&&values[key]>=0?values[key]:0;
  // Clean inactive file pages are reclaimable by the kernel. Counting them as
  // permanently occupied makes a sequential ISO upload stop after filling the
  // page cache, even though the service's working set is still small. Do not
  // count anonymous memory, shared memory, dirty pages or writeback as free.
  const reclaimable=Math.max(0,counter('inactive_file')-counter('file_dirty')-counter('file_writeback')-counter('shmem'));
  return Math.max(0,maximum-current+Math.min(current,reclaimable));
}
export function availableMediaMemory() {
  if(process.platform==='linux') {
    try {
      const available=Number(/^MemAvailable:\s+(\d+)/m.exec(readFileSync('/proc/meminfo','utf8'))?.[1])*1024;
      if(!Number.isFinite(available))throw Error('memory telemetry missing');
      try {
        const maximum=readFileSync('/sys/fs/cgroup/memory.max','utf8').trim();
        if(maximum!=='max'){
          const current=Number(readFileSync('/sys/fs/cgroup/memory.current','utf8'));
          let stat='';try{stat=readFileSync('/sys/fs/cgroup/memory.stat','utf8');}catch{/* Conservative headroom without cache telemetry. */}
          return Math.max(0,Math.min(available,cgroupMediaHeadroom(Number(maximum),current,stat)));
        }
      }catch{/* Non-container Linux process: host available memory applies. */}
      return available;
    }catch{/* Other supported platforms use the runtime's memory observation. */}
  }
  return process.availableMemory?.()??freemem();
}
// Legacy model protocols still materialize a buffer, base64, JSON and decoded
// strings. Account for those copies against live process/container resources.
// This is not a product file-size quota, and does not apply to streaming upload.
export function bufferedMediaBytes({available=availableMediaMemory,
  heap=()=>{const h=getHeapStatistics();return h.heap_size_limit-h.used_heap_size;},copies=8,account=defaultAccount}={}) {
  if(!Number.isFinite(copies)||copies<1)throw new TypeError('Invalid media memory accounting');
  const bytes=Math.min(available(),heap());
  if(!Number.isFinite(bytes)||bytes<0)throw new TypeError('Available media memory is unknown');
  return Math.max(0,Math.floor(Math.min((bytes-held(account))/copies,
    constants.MAX_LENGTH,constants.MAX_STRING_LENGTH*3/4)));
}

/** Buffer an existing legacy JSON response only after admitting its real memory
 * cost. Incremental bodies cannot evade admission by omitting Content-Length. */
export async function bufferedMediaResponse(response,options={}) {
  const parts=[],releases=[];let total=0,reservedBytes=0,completed=false;
  // Fetch decodes gzip/br/deflate while retaining the wire headers. Their
  // Content-Length describes compressed bytes, not the body being iterated.
  // Admit the decoded chunks incrementally in that case; never compare the
  // decompressed byte count with the compressed transfer size.
  const encoding=response.headers.get('content-encoding')?.trim().toLowerCase();
  const declared=encoding && encoding!=='identity' ? 0 : Number(response.headers.get('content-length')??0);
  try{
    if(Number.isSafeInteger(declared)&&declared>0){releases.push(reserveBufferedMedia(declared,options));reservedBytes=declared;}
    if(response.body){
      for await(const bytes of response.body){
        if(total+bytes.length>reservedBytes){releases.push(reserveBufferedMedia(total+bytes.length-reservedBytes,options));reservedBytes=total+bytes.length;}
        parts.push(Buffer.from(bytes));total+=bytes.length;
      }
    }
    if(declared>0&&declared!==total)throw new PlatformError('media_response_invalid','Response length did not match',{status:502});
    const result=Buffer.concat(parts,total);completed=true;return result;
  }finally{
    for(const part of parts)part.fill(0);for(const release of releases)release();
    // Admission can fail before iteration begins. In that case for-await has
    // no iterator to close: explicitly release the unread network response.
    if(!completed){try{
      if(response.body?.cancel)await response.body.cancel();
      else response.body?.destroy?.();
    }catch{/* Already cancelled/locked by the failing iterator. */}}
  }
}

export function reserveBufferedMedia(size,options={}) {
  if(!Number.isSafeInteger(size)||size<1)throw new PlatformError('invalid_object_content','File size is invalid',{status:400});
  if(size>bufferedMediaBytes(options))throw new PlatformError('media_memory_unavailable',
    '当前处理服务没有足够的可用内存处理此文件；文件大小不是产品配额。请稍后重试或增加处理资源。',
    {status:503,retryable:true});
  const account=options.account??defaultAccount,bytes=size*(options.copies??8);
  accounts.set(account,held(account)+bytes);let released=false;
  return ()=>{if(!released){released=true;accounts.set(account,held(account)-bytes);}};
}
