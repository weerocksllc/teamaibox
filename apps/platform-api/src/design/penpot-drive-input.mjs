import { createHash } from 'node:crypto';
import { PlatformError } from '../../../../packages/observability/src/index.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^sha256:[a-f0-9]{64}$/;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE_BYTES = 4 * MAX_BYTES;

// Reject clearly truncated inputs before dispatch. A local file signature on
// its own leaves native ZIP failures looking like a lost write receipt. The
// native Penpot parser remains responsible for manifest and entry validation.
function penpotArchive(bytes) {
  if (bytes.length < 52 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  for (let end = bytes.length - 22; end >= Math.max(30, bytes.length - 22 - 0xffff); end--) {
    if (bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) continue;
    const disk = bytes.readUInt16LE(end + 4), directoryDisk = bytes.readUInt16LE(end + 6);
    const entries = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
    return disk === 0 && directoryDisk === 0 && entries > 0 && entries === bytes.readUInt16LE(end + 8)
      && size >= 46 * entries && offset >= 30 && offset + size === end && bytes.readUInt32LE(offset) === 0x02014b50;
  }
  return false;
}

const TYPES = Object.freeze({
  'image/png': bytes => bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),
  'image/jpeg': bytes => bytes.length >= 4 && bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')),
  'image/webp': bytes => bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP',
  'application/x-penpot': penpotArchive,
});
const invalid = (status=400) => new PlatformError('penpot_drive_input_invalid','The selected design input is unavailable or unsupported',{status});
const changed = () => new PlatformError('penpot_drive_source_changed','The selected drive version changed',{status:409});

function selection(row, {fileId,version,format}) {
  if (row?.fileId !== fileId || row.version !== version || !UUID.test(row.objectId ?? '')
      || !Number.isSafeInteger(row.objectVersion) || row.objectVersion < 1 || !SHA.test(row.sha256 ?? '')
      || !Number.isSafeInteger(row.size) || row.size < 1) throw invalid(409);
  if (row.size > MAX_BYTES) throw invalid(413);
  const acceptable = format === 'application/x-penpot'
    ? new Set(['application/x-penpot','application/zip','application/octet-stream'])
    : new Set([format]);
  if (!acceptable.has(row.mediaType)) throw invalid(415);
  return Object.freeze({fileId,version,objectId:row.objectId,objectVersion:row.objectVersion,
    size:row.size,sha256:row.sha256,mediaType:row.mediaType,format});
}

function equal(a,b) {
  return ['fileId','version','objectId','objectVersion','size','sha256','mediaType','format'].every(key=>a[key]===b[key]);
}

/** Read one explicitly chosen immutable version using the existing Drive ACL
 * and private object gateway. Never return a URL, grant, path, or storage key.
 * A native importer must run its own final target and parser checks; this
 * adapter does not itself mutate either system. */
export class PenpotDriveInput {
  #drive; #objects; #activeBytes=0;
  constructor({teamDrive,objectGateway}) {
    if (!teamDrive?.download || !teamDrive?.versions || !objectGateway?.downloadStream || !objectGateway?.revoke) {
      throw new TypeError('Design input requires the protected Team Drive and object gateway');
    }
    this.#drive=teamDrive;this.#objects=objectGateway;
  }
  async read({fileId,version,format,currentActor,signal}) {
    if (!UUID.test(fileId ?? '') || !Number.isSafeInteger(version) || version < 1
        || typeof format !== 'string' || !Object.hasOwn(TYPES,format) || typeof currentActor !== 'function') throw invalid();
    signal?.throwIfAborted();
    const actor = await currentActor();
    if (!UUID.test(actor?.actorIdentityId ?? '')) throw invalid(403);
    const input={fileId,version,format};
    const grant=await this.#drive.download(actor,fileId,{version});
    if (!UUID.test(grant?.referenceId ?? '')) throw invalid(409);
    const access={actorIdentityId:actor.actorIdentityId,referenceId:grant.referenceId,audience:'team-drive.download'};
    let content,retained=false,reserved=0;
    const release=()=>{
      if(!reserved)return;
      content?.fill(0);this.#activeBytes-=reserved;reserved=0;
    };
    try {
      const selected=selection(grant.version,input);
      if(this.#activeBytes+selected.size>MAX_ACTIVE_BYTES) throw invalid(503);
      reserved=selected.size;this.#activeBytes+=reserved;
      content=Buffer.alloc(selected.size);
      const verify=createHash('sha256');
      const stream=await this.#objects.downloadStream(access);
      let offset=0;
      try {
        for await (const chunk of stream.chunks) {
          signal?.throwIfAborted();
          if (!Buffer.isBuffer(chunk) || chunk.length>selected.size-offset) throw changed();
          chunk.copy(content,offset);verify.update(chunk);offset+=chunk.length;
        }
      } finally { await stream.chunks.return?.(); }
      if (offset!==selected.size || 'sha256:'+verify.digest('hex')!==selected.sha256) throw changed();
      if (!TYPES[format](content)) throw invalid(415);
      // Check the chosen entry, not "any entry that has the same object".
      // Re-authentication lets team and share revocation take effect.
      const recheck=async()=>{
        signal?.throwIfAborted();
        const live=await currentActor();
        if (live?.actorIdentityId!==actor.actorIdentityId) throw invalid(403);
        const versions=await this.#drive.versions(live,fileId);
        if (!equal(selected,selection(versions.find(row=>row.version===version),input))) throw changed();
      };
      await recheck();
      retained=true;
      return Object.freeze({selected,content,recheck,release});
    } finally {
      if (!retained) release();
      // No external client receives the grant. Expiry still bounds it if a
      // failed network response prevents the private revocation call.
      await this.#objects.revoke({...access,reason:'penpot_drive_read_finished'}).catch(()=>{});
    }
  }
}
