import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {ProtectedObjectService} from '../../../services/object-service/src/object-service.mjs';
import {MemoryObjectRepository} from '../../../services/object-service/src/memory-repository.mjs';
import {MemoryBlobStore} from '../../../services/object-service/src/memory-blob-store.mjs';
import {MemoryFileRepository} from '../../../services/object-service/src/memory-file-repository.mjs';
import {TeamDriveService} from '../../../services/object-service/src/team-drive-service.mjs';
import {InstallationObjectTransfer} from '../src/virtual-computers/installation-object-transfer.mjs';
import {inspectInstallationIso} from '../src/virtual-computers/inspect-installation-iso.mjs';

function iso(machine=0xaa64){
  const b=Buffer.alloc(90*2048);
  const record=(name,sector,size,directory=true)=>{
    const n=Buffer.from(name),r=Buffer.alloc(33+n.length+(n.length%2?0:1));r[0]=r.length;
    r.writeUInt32LE(sector,2);r.writeUInt32BE(sector,6);r.writeUInt32LE(size,10);r.writeUInt32BE(size,14);
    r[25]=directory?2:0;r[32]=n.length;n.copy(r,33);return r;
  };
  b.set([1,...Buffer.from('CD001'),1],16*2048);b.writeUInt32LE(90,16*2048+80);b.writeUInt16LE(2048,16*2048+128);
  record('\0',20,2048).copy(b,16*2048+156);record('EFI',21,2048).copy(b,20*2048);
  record('BOOT',22,2048).copy(b,21*2048);record('BOOTAA64.EFI;1',23,128,false).copy(b,22*2048);
  b.write('MZ',23*2048);b.writeUInt32LE(64,23*2048+60);b.write('PE\0\0',23*2048+64);b.writeUInt16LE(machine,23*2048+68);
  return b;
}
function fixture(){
  const owner=randomUUID(),member=randomUUID();
  const objects=new ProtectedObjectService({repository:new MemoryObjectRepository(),blobStore:new MemoryBlobStore(),
    referenceSigningKey:randomBytes(32),allowTestPlaintextBlobStore:true});
  const gateway=objects.createObjectHandoffGateway();
  const drive=new TeamDriveService({repository:new MemoryFileRepository(),objectReferences:{resolve:i=>gateway.resolve(i),
    issueReadReference:i=>gateway.issue({...i,operations:['head','read','range']})}});
  const context=id=>({actorIdentityId:id,permissions:['file:read','file:write','file:share','file:manage'],teamRoles:{}});
  const store=async(content=iso(),who=owner,key='virtual-computers/installation/'+randomUUID()+'/test.iso')=>gateway.storeOutput({
    actorIdentityId:who,objectKey:key,contentType:'application/x-iso9660-image',content,expectedSha256:createHash('sha256').update(content).digest('hex')});
  const reference=(m,who,audience)=>gateway.issue({actorIdentityId:who,objectId:m.objectId,objectVersion:m.version,audience,
    operations:['head','read','range'],expiresInSeconds:300});
  const transfer=new InstallationObjectTransfer({objectService:objects,teamDrive:drive});
  const scope=id=>({namespaceKey:`user:${id}`,context:{identityId:id,identityKind:'local_user',namespaceAccess:[{namespaceKey:`user:${id}`,operations:['read','list']}]}});
  return {owner,member,objects,drive,transfer,store,reference,context,scope};
}

test('ISO metadata ranges identify actual PE architecture without a full-object read or ISO size ceiling',async()=>{
  for(const [machine,expected] of [[0xaa64,'arm64'],[0x8664,'wrong-architecture'],[0,'unverified']]){
    const b=iso(machine),size=20*1024**3;
    const result=await inspectInstallationIso({size,readRange:async(start,count)=>{
      assert.ok(count<=4*1024**2);const out=Buffer.alloc(count);b.subarray(start,start+count).copy(out);return out;
    }});
    assert.equal(result.compatibility,expected);assert.ok(result.metadataBytesRead<4*1024**2);
  }
  await assert.rejects(inspectInstallationIso({size:100000,readRange:async()=>{throw Error('storage unavailable');}}),/storage unavailable/);
});

test('ISO descriptor scan batches authenticated ranges rather than decrypting once per sector',async()=>{
  const content=iso(),ranges=[];
  const result=await inspectInstallationIso({size:content.length,readRange:async(start,count)=>{
    ranges.push({start,count});return content.subarray(start,start+count);
  }});
  assert.equal(result.compatibility,'arm64');
  assert.deepEqual(ranges,[{start:16*2048,count:64*2048}]);
  assert.ok(result.metadataBytesRead<4*1024**2);
});

test('uploaded ISO import binds the owned immutable version and rejects another owner even with a reference',async()=>{
  const f=fixture(),object=await f.store(),ref=await f.reference(object,f.owner,'virtual-computer.iso');
  const input={source:'upload',name:'test.iso',referenceId:ref.referenceId};
  const source=await f.transfer.source({ownerId:f.owner,input,driveContext:f.context(f.owner)});
  const result=await f.transfer.prepare({media:{id:randomUUID(),ownerId:f.owner,source},driveContext:f.context(f.owner)});
  assert.equal(result.objectId,object.objectId);assert.equal(result.compatibility,'arm64');
  const foreignRef=await f.reference(object,f.member,'virtual-computer.iso');
  await assert.rejects(f.transfer.source({ownerId:f.member,input:{...input,referenceId:foreignRef.referenceId},driveContext:f.context(f.member)}));
});

async function sharedIso(f){
  const object=await f.store(),ref=await f.reference(object,f.owner,'team-drive.file');
  const root=await f.drive.createRoot(f.context(f.owner),{scopeKind:'user',scopeKey:f.owner});
  const file=await f.drive.createFile(f.context(f.owner),root.id,{name:'test.iso',objectReferenceId:ref.referenceId});
  const share=await f.drive.share(f.context(f.owner),file.entry.id,{principalKind:'identity',principalKey:f.member,role:'viewer'});
  const input={source:'drive',name:'test.iso',fileId:file.entry.id,version:1};
  const source=await f.transfer.source({ownerId:f.member,input,driveContext:f.context(f.member)});
  return {object,file,share,input,source};
}

test('drive import creates one private copy, survives source edits/revocation, and never deletes source',async()=>{
  const f=fixture(),s=await sharedIso(f),media={id:randomUUID(),ownerId:f.member,source:s.source};
  const result=await f.transfer.prepare({media,driveContext:f.context(f.member)});
  assert.notEqual(result.objectId,s.object.objectId);assert.equal(result.compatibility,'arm64');
  const replacement=await f.store(iso(0x8664)),ref=await f.reference(replacement,f.owner,'team-drive.file');
  await f.drive.addVersion(f.context(f.owner),s.file.entry.id,{expectedRevision:s.file.entry.revision,objectReferenceId:ref.referenceId});
  await f.drive.revokeShare(f.context(f.owner),s.share.id);
  assert.deepEqual(await f.transfer.prepare({media,driveContext:f.context(f.member)}),result);
  await assert.rejects(f.transfer.source({ownerId:f.member,input:s.input,driveContext:f.context(f.member)}),{code:'file_not_found'});
  const copies=await f.objects.list({...f.scope(f.member),prefix:'virtual-computers/installation-copies/'});
  assert.equal(copies.items.length,1);
  await f.transfer.release({...media,...result});await f.transfer.release({...media,...result});
  assert.ok(await f.objects.head({...f.scope(f.owner),objectId:s.object.objectId,version:1}));
});

test('revoked drive access before copy blocks it; lost completion response recovers the same private object',async()=>{
  const f=fixture(),s=await sharedIso(f),media={id:randomUUID(),ownerId:f.member,source:s.source};
  await f.drive.revokeShare(f.context(f.owner),s.share.id);
  await assert.rejects(f.transfer.prepare({media,driveContext:f.context(f.member)}),{code:'file_not_found'});
  await f.drive.share(f.context(f.owner),s.file.entry.id,{principalKind:'identity',principalKey:f.member,role:'viewer'});
  const complete=f.objects.completeMultipart.bind(f.objects);let calls=0;
  f.objects.completeMultipart=async input=>{calls++;await complete(input);throw Error('lost reply');};
  const result=await f.transfer.prepare({media,driveContext:f.context(f.member)});
  assert.equal(result.compatibility,'arm64');assert.equal(calls,1);
  assert.deepEqual(await f.transfer.prepare({media,driveContext:f.context(f.member)}),result);assert.equal(calls,1);
});
