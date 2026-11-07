import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PlatformError } from '../../../packages/observability/src/index.mjs';
import { PenpotDriveInput } from '../src/design/penpot-drive-input.mjs';

const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
function fixture({bytes=png,streamBytes=bytes,mediaType='image/png',size=bytes.length}={}){
  const owner=randomUUID(), fileId=randomUUID(), referenceId=randomUUID(), objectId=randomUUID();
  const chosen={fileId,version:1,objectId,objectVersion:3,size,mediaType,
    sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
  const latest={...chosen,version:2,objectVersion:4};
  let live=[chosen,latest], identity=owner, mayRead=true, duringRead=()=>{};
  const revoke=[];
  const check=actor=>{
    if(!mayRead||actor.actorIdentityId!==owner)throw new PlatformError('file_not_found','Unavailable',{status:404});
  };
  const adapter=new PenpotDriveInput({teamDrive:{
    async download(actor,id,{version}){check(actor);assert.equal(id,fileId);assert.equal(version,1);return {referenceId,version:chosen};},
    async versions(actor,id){check(actor);assert.equal(id,fileId);return live;},
  },objectGateway:{
    async downloadStream(access){
      assert.deepEqual(access,{actorIdentityId:owner,referenceId,audience:'team-drive.download'});
      return {chunks:(async function*(){yield streamBytes.subarray(0,8);duringRead();yield streamBytes.subarray(8);})()};
    },
    async revoke(access){revoke.push(access);},
  }});
  return {adapter,chosen,revoke,latest,read:(extra={})=>adapter.read({fileId,version:1,format:'image/png',
    currentActor:async()=>({actorIdentityId:identity}),...extra}),
  switchUser:()=>{identity=randomUUID();}, change:()=>{live=[{...chosen,objectVersion:12},latest];},
  remove:()=>{mayRead=false;}, onRead:callback=>{duringRead=callback;}};
}

test('design read keeps the selected old Drive version, revokes its grant and supports a commit-time recheck',async()=>{
  const f=fixture(), selected=await f.read();
  try{
    assert.equal(selected.selected.version,1);assert.equal(selected.selected.objectVersion,3);
    assert.deepEqual(selected.content,png);assert.equal(f.revoke.length,1);
    assert.ok(!Object.hasOwn(selected,'referenceId'));
    f.change();await assert.rejects(selected.recheck(),{code:'penpot_drive_source_changed'});
    f.switchUser();await assert.rejects(selected.recheck(),{status:403});
  }finally{selected.release();selected.release();}
  assert.ok(selected.content.every(byte=>byte===0));
});

test('revocation during streaming prevents handoff and revokes the issued reference',async()=>{
  const f=fixture();f.onRead(f.remove);
  await assert.rejects(f.read(),{status:404});assert.equal(f.revoke.length,1);
});

test('altered bytes, unsupported content and implicit latest never become import input',async()=>{
  const changed=fixture({streamBytes:Buffer.concat([png.subarray(0,-1),Buffer.of(7)])});
  await assert.rejects(changed.read(),{code:'penpot_drive_source_changed'});assert.equal(changed.revoke.length,1);
  const impostor=fixture({bytes:Buffer.from('<svg onload="alert(1)"></svg>')});
  await assert.rejects(impostor.read(),{status:415});assert.equal(impostor.revoke.length,1);
  await assert.rejects(impostor.read({version:null}),{status:400});assert.equal(impostor.revoke.length,1);
});

test('the native archive handoff rejects a truncated ZIP envelope before dispatch',async()=>{
  const mediaType='application/x-penpot';
  const local=Buffer.alloc(32), central=Buffer.alloc(47), end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(1,26);local.write('a',30);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(1,28);central.write('a',46);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);
  end.writeUInt32LE(central.length,12);end.writeUInt32LE(local.length,16);
  const zip=Buffer.concat([local,central,end]);
  const complete=await fixture({bytes:zip,mediaType}).read({format:mediaType});
  try{assert.deepEqual(complete.content,zip);}finally{complete.release();}
  const truncated=fixture({bytes:zip.subarray(0,-end.length),mediaType});
  await assert.rejects(truncated.read({format:mediaType}),{status:415});assert.equal(truncated.revoke.length,1);
  end.writeUInt32LE(0xffff_ffff,16);
  await assert.rejects(fixture({bytes:Buffer.concat([local,central,end]),mediaType}).read({format:mediaType}),{status:415});
  const tooLarge=fixture({bytes:zip,mediaType,size:32*1024*1024+1});
  await assert.rejects(tooLarge.read({format:mediaType}),{status:413});assert.equal(tooLarge.revoke.length,1);
});
