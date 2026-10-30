import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {PostgresComputerRepository} from '../src/virtual-computers/postgres-computer-repository.mjs';
import {computerCommand,validateComputerCommandResult} from '../../../services/scheduler/src/computer-command.mjs';

test('persistent installation controls serialize optical changes without changing guest identity or power state',{
  skip:!process.env.TEAMAIBOX_INSTALLATION_PGLITE_MODULE,
},async()=>{
  const {PGlite}=await import(pathToFileURL(process.env.TEAMAIBOX_INSTALLATION_PGLITE_MODULE));
  const db=new PGlite(),owner=randomUUID(),other=randomUUID(),id=randomUUID(),legacy=randomUUID(),node=randomUUID(),media=randomUUID(),object=randomUUID();
  try {
    await db.exec(`CREATE SCHEMA iam;CREATE SCHEMA platform;CREATE SCHEMA compute;CREATE SCHEMA objects;
      CREATE TABLE iam.identities(id uuid PRIMARY KEY,status text);
      CREATE TABLE compute.nodes(id uuid PRIMARY KEY);
      CREATE TABLE objects.object_entries(id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE objects.object_versions(object_id uuid,version integer,PRIMARY KEY(object_id,version));
      CREATE TABLE objects.storage_pools(pool_id text PRIMARY KEY);
      CREATE TABLE platform.computer_profiles(id text PRIMARY KEY);`);
    const original=await readFile(new URL('../../../packages/persistence/migrations/000100_virtual_computers.up.sql',import.meta.url),'utf8');
    await db.exec(original.slice(original.indexOf('CREATE TABLE platform.computers ('),original.indexOf('-- Commitments survive')));
    for(const version of ['000112_computer_installation_media','000113_computer_installation_operations'])
      await db.exec(await readFile(new URL(`../../../packages/persistence/migrations/${version}.up.sql`,import.meta.url),'utf8'));
    await db.query("INSERT INTO iam.identities VALUES($1,'active'),($2,'active')",[owner,other]);
    await db.query('INSERT INTO compute.nodes VALUES($1)',[node]);
    await db.exec("INSERT INTO objects.storage_pools VALUES('test-pool');INSERT INTO platform.computer_profiles VALUES('linux-arm64');");
    const profile={id:'linux-arm64',schemaVersion:2,runtimeImage:'sha256:'+'1'.repeat(64)};
    const resources={vcpus:2,memoryBytes:4*1024**3,diskBytes:32*1024**3};
    for(const computer of [id,legacy])await db.query(`INSERT INTO platform.computers
      (id,owner_id,node_id,pool_id,profile_id,volume_id,firmware_id,name,state,revision,generation,profile,resources)
      VALUES($1,$2,$3,'test-pool','linux-arm64',$4,$5,'isolated installation fixture','stopped',1,0,$6,$7)`,
      [computer,owner,node,randomUUID(),randomUUID(),computer===id?profile:{...profile,schemaVersion:1},resources]);
    await db.query('INSERT INTO platform.computer_installations(computer_id,owner_id) VALUES($1,$2)',[id,owner]);
    await db.query('INSERT INTO objects.object_entries VALUES($1,NULL)',[object]);
    await db.query('INSERT INTO objects.object_versions VALUES($1,1)',[object]);
    await db.query(`INSERT INTO platform.computer_installation_media
      (id,owner_id,request_key,request_fingerprint,name,source,state,object_id,object_version,digest,size_bytes,compatibility)
      VALUES($1,$2,'fixture',$3,'Linux.iso','{"kind":"upload"}','ready',$4,1,$5,123456,'arm64')`,
      [media,owner,'a'.repeat(64),object,'sha256:'+'b'.repeat(64)]);
    const repo=new PostgresComputerRepository({database:db});
    const before=await repo.get(owner,id),oldBefore=await repo.get(owner,legacy);
    const request=(action,input,key=randomUUID(),computerId=id,ownerId=owner)=>repo.requestInstallation({ownerId,computerId,action,input,key});
    assert.equal(await repo.getInstallation(owner,legacy),null);
    await assert.rejects(request('eject',{expectedRevision:1},randomUUID(),legacy),{code:'computer_installation_upgrade_required'});
    await assert.rejects(request('mount',{expectedRevision:1,mediaId:media},randomUUID(),id,other),{code:'computer_not_found'});
    const key=randomUUID(),input={expectedRevision:1,mediaId:media};
    const mount=await request('mount',input,key);
    assert.deepEqual(await request('mount',input,key),mount);
    await assert.rejects(request('eject',{expectedRevision:1},key),{code:'computer_idempotency_conflict'});
    await assert.rejects(request('installed',{expectedRevision:2}),{code:'computer_operation_pending'});
    const payload=computerCommand(mount);
    assert.equal(payload.installation.digest,'sha256:'+'b'.repeat(64));
    let claim=await repo.claimNext({leaseMs:30000});
    const resultFor=op=>{
      const p=computerCommand(op);
      return Object.fromEntries(['computerId','ownerId','nodeId','volumeId','firmwareId','tpmId','operationId','generation'].map(k=>[k,p[k]]));
    };
    let result={...resultFor(claim),installationRevision:2,mediaDigest:payload.installation.digest,mediaReady:true};
    validateComputerCommandResult('installation',payload,result);
    await assert.rejects(repo.complete(claim,{...result,installationRevision:1}),{code:'node_agent_protocol_mismatch'});
    await repo.complete(claim,result);
    assert.equal((await repo.getInstallation(owner,id)).observedMediaId,media);
    assert.deepEqual(await repo.get(owner,id),before);
    const bootKey=randomUUID();
    const boot=await request('boot-disc',{expectedRevision:3},bootKey);
    assert.equal(boot.state,'succeeded');
    assert.equal((await repo.getInstallation(owner,id)).boot.state,'pending');
    assert.deepEqual(await request('boot-disc',{expectedRevision:3},bootKey),boot);
    await assert.rejects(request('eject',{expectedRevision:4}),{code:'computer_installation_boot_pending'});
    await request('cancel-boot',{expectedRevision:4});
    await request('eject',{expectedRevision:5});
    claim=await repo.claimNext({leaseMs:30000});
    result={...resultFor(claim),installationRevision:6,mediaDigest:null,mediaReady:true};
    await repo.complete(claim,result);
    await request('installed',{expectedRevision:7});
    assert.equal((await repo.getInstallation(owner,id)).phase,'user-confirmed');
    assert.deepEqual(await repo.get(owner,id),before);
    assert.deepEqual(await repo.get(owner,legacy),oldBefore);
    await assert.rejects(repo.requestInstallation({ownerId:owner,computerId:legacy,action:'adopt',input:{expectedRevision:1},key:randomUUID()}),{code:'computer_installation_upgrade_required'});
    const upgraded='sha256:'+'2'.repeat(64),adoptionKey=randomUUID();
    const adoption={ownerId:owner,computerId:legacy,action:'adopt',input:{expectedRevision:1},key:adoptionKey,
      policy:{runtimeUpdates:{'linux-arm64':{from:profile.runtimeImage,to:upgraded}},mediaRuntimeImages:[upgraded]}};
    const adopted=await repo.requestInstallation(adoption);
    assert.equal(adopted.state,'succeeded');assert.deepEqual(await repo.requestInstallation(adoption),adopted);
    const afterAdoption=await repo.get(owner,legacy);
    assert.deepEqual({...afterAdoption,revision:oldBefore.revision,profile:oldBefore.profile},oldBefore);
    assert.equal(afterAdoption.profile.schemaVersion,1);assert.equal(afterAdoption.profile.runtimeImage,upgraded);
    assert.equal((await repo.getInstallation(owner,legacy)).phase,'user-confirmed');
    const legacyMount=await request('mount',{expectedRevision:1,mediaId:media},randomUUID(),legacy);
    assert.equal(legacyMount.command.profile.schemaVersion,1);assert.equal(legacyMount.command.volumeId,oldBefore.volumeId);
    await assert.rejects(db.exec(await readFile(new URL('../../../packages/persistence/migrations/000113_computer_installation_operations.down.sql',import.meta.url),'utf8')),/cannot remove persisted/);
  }finally{await db.close();}
});
