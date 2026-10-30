import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {PostgresDatabase} from '../../../packages/persistence/src/postgres-database.mjs';
import {PostgresComputerRepository} from '../src/virtual-computers/postgres-computer-repository.mjs';
import {PostgresComputerCapacity} from '../../../services/scheduler/src/postgres-computer-capacity.mjs';
import {profileRevision} from '../src/virtual-computers/computer-profiles.mjs';
const pg=createRequire(new URL('../../../packages/persistence/package.json',import.meta.url))('pg');

// Explicit opt-in: only an isolated PostgreSQL fixture reachable via loopback.
// Creates and drops its own random database, never a product schema/database.
test('real PostgreSQL computer lifecycle: concurrency, replay, fencing and immutable disks',{
  skip:!process.env.TEAMAIBOX_COMPUTER_TEST_PG_PORT,timeout:60000,
},async t=>{
  const port=Number(process.env.TEAMAIBOX_COMPUTER_TEST_PG_PORT);
  assert.ok(Number.isInteger(port)&&port>0&&port<=65535);
  const dbName='computer_test_'+randomUUID().replaceAll('-','');
  const settings={host:'127.0.0.1',port,user:'postgres',connectionTimeoutMillis:5000};
  const admin=new pg.Pool({...settings,database:'postgres'});
  let pool;
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
    pool=new pg.Pool({...settings,database:dbName,max:8});
    const database=new PostgresDatabase({pool});
    const migrationRoot=new URL('../../../packages/persistence/migrations/',import.meta.url);
    const manifest=JSON.parse(await readFile(new URL('manifest.json',migrationRoot),'utf8'));
    for(const migration of manifest.migrations.filter(m=>m.version<100)) {
      await pool.query(await readFile(new URL(migration.up,migrationRoot),'utf8'));
    }
    const up=await readFile(new URL('../../../packages/persistence/migrations/000100_virtual_computers.up.sql',import.meta.url),'utf8');
    const down=await readFile(new URL('../../../packages/persistence/migrations/000100_virtual_computers.down.sql',import.meta.url),'utf8');
    await pool.query(up);
    await pool.query(down); // empty schema supports reversible migration
    await pool.query(up);
    for(const migration of manifest.migrations.filter(m=>m.version>100)) {
      await pool.query(await readFile(new URL(migration.up,migrationRoot),'utf8'));
    }
    const owner=randomUUID(),other=randomUUID(),node=randomUUID();
    await pool.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,display_name,password_hash,status)
      VALUES($1,'local_user','test-owner','test-owner','Test owner','fixture-only','active'),
        ($2,'local_user','test-other','test-other','Test other','fixture-only','active')`,[owner,other]);
    await pool.query(`INSERT INTO compute.nodes(id,node_key,architecture,trust_kind,lifecycle_state)
      VALUES($1,'test-node','arm64','managed_appliance','ready')`,[node]);
    await pool.query(`INSERT INTO objects.storage_pools(pool_id,node_id,display_name,backend_kind,failure_domain,encryption_mode,
      encryption_status,encryption_verified_at,health_state,compatibility_status,compatibility_verified_at,lifecycle_state)
      VALUES('test-pool',$1,'Test pool','local-block','test-domain','luks2','verified',clock_timestamp(),'healthy','verified',clock_timestamp(),'active')`,[node]);
    const profile={id:'windows11-test',name:'Windows 11',version:'fixture',edition:'Pro',runtimeImage:'sha256:'+'a'.repeat(64),
      mediaDigest:'sha256:'+'b'.repeat(64),firmwareDigest:'sha256:'+'c'.repeat(64),driverDigest:'sha256:'+'d'.repeat(64),
      minimum:{vcpus:2,memoryGiB:4,diskGiB:64},tpm:true,secureBoot:true,remoteDesktop:true,rights:{activationRequired:true}};
    await pool.query(`INSERT INTO platform.computer_profiles(id,profile,create_enabled) VALUES($1,$2,true)`,[profile.id,profile]);
    const repo=new PostgresComputerRepository({database});
    const input={name:'测试电脑',profileId:profile.id,resources:{vcpus:4,memoryGiB:8,diskGiB:128}};
    let storageChecks=0;
    const placement={nodeId:node,poolId:'test-pool',prepareStorage:async()=>{storageChecks++;}};
    const create=key=>repo.requestCreate({ownerId:owner,input,key,placement,policy:{storedPerUser:1}});
    let createOp,computer;
    const claim=()=>repo.claimNext({leaseMs:30000});
    const result=(op,extras)=>({...op.command,operationId:op.id,...extras});
    await t.test('simultaneous identical requests produce one computer, operation and storage check',async()=>{
      const ops=await Promise.all([create('create-1'),create('create-1'),create('create-1')]);
      assert.equal(new Set(ops.map(o=>o.id)).size,1);assert.equal(storageChecks,1);
      createOp=ops[0];computer=await repo.get(owner,createOp.computerId);
      assert.equal((await repo.list(owner)).length,1);
      await assert.rejects(create('another-create'),{code:'computer_stored_quota'});
      await assert.rejects(repo.requestCreate({ownerId:owner,input:{...input,name:'other'},key:'create-1',placement}),{code:'computer_idempotency_conflict'});
    });
    await t.test('other members cannot read computers or their operation records',async()=>{
      await assert.rejects(repo.get(other,computer.id),{code:'computer_not_found'});
      await assert.rejects(repo.getOperation(other,createOp.id),{code:'computer_not_found'});
    });
    await t.test('two process workers cannot claim one operation at the same time',async()=>{
      const claims=await Promise.all([claim(),claim()]);assert.equal(claims.filter(Boolean).length,1);
      createOp=claims.find(Boolean);
      await repo.complete(createOp,result(createOp,{provisioned:true,encryption:'luks2'}));
      assert.equal((await repo.get(owner,computer.id)).state,'stopped');
    });
    let startOp;
    await t.test('a lost response keeps the exact operation/run and rejects a new conflicting request',async()=>{
      computer=await repo.get(owner,computer.id);
      await repo.requestAction({ownerId:owner,computerId:computer.id,action:'start',input:{expectedRevision:computer.revision},key:'start-1'});
      startOp=await claim();
      await repo.retry(startOp);
      const started=await repo.get(owner,computer.id);assert.ok(started.run.id);assert.equal(started.state,'starting');
      assert.equal(await claim(),null);
      await assert.rejects(repo.requestAction({ownerId:owner,computerId:computer.id,action:'start',input:{expectedRevision:started.revision},key:'start-2'}),{code:'computer_operation_pending'});
      // Simulate expiration in this isolated fixture, not a sleep or live outage.
      await pool.query(`UPDATE platform.computer_operations SET claimed_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[startOp.id]);
      const replacement=await new PostgresComputerRepository({database}).claimNext({leaseMs:30000});
      assert.equal(replacement.id,startOp.id);assert.deepEqual(replacement.command,startOp.command);assert.notEqual(replacement.claimId,startOp.claimId);
      const proof=result(replacement,{running:true,runId:started.run.id,runtimeImage:profile.runtimeImage,containerId:'e'.repeat(64)});
      await assert.rejects(repo.complete(startOp,proof),{code:'computer_state_conflict'});
      await repo.complete(replacement,proof);startOp=replacement;
    });
    await t.test('profile replacement, disk replacement and lossy downgrade are refused',async()=>{
      await assert.rejects(pool.query(`UPDATE platform.computer_profiles SET profile=jsonb_set(profile,'{version}','"new"') WHERE id=$1`,[profile.id]),/new profile/);
      await assert.rejects(pool.query(`UPDATE platform.computers SET volume_id=$2,revision=revision+1 WHERE id=$1`,[computer.id,randomUUID()]),/identity is immutable/);
      await assert.rejects(pool.query(down),/cannot remove persisted/);
    });
    await t.test('shutdown requires exact confirmed container and resource release before marking stopped',async()=>{
      const current=await repo.get(owner,computer.id);
      await repo.requestAction({ownerId:owner,computerId:computer.id,action:'shutdown',input:{expectedRevision:current.revision},key:'shutdown-1'});
      const op=await claim(),proof=result(op,{stopped:true,cleanShutdown:true,runId:current.run.id,containerId:current.run.containerId});
      await assert.rejects(repo.complete(op,{...proof,containerId:'f'.repeat(64)},{releaseResources:async()=>{throw Error('must not release');}}),{code:'computer_result_mismatch'});
      await assert.rejects(repo.complete(op,proof),{code:'computer_capacity_unavailable'});
      assert.ok((await repo.get(owner,computer.id)).run);
      let released=0;
      await repo.complete(op,proof,{releaseResources:async()=>{released++;}});
      await repo.complete(op,proof,{releaseResources:async()=>{released++;}});
      assert.equal(released,1);assert.equal((await repo.get(owner,computer.id)).run,null);
    });
    await t.test('maintenance changes only the next stopped run runtime and preserves disk, TPM and history',async()=>{
      const before=await repo.get(owner,computer.id),to='sha256:'+'9'.repeat(64);
      await assert.rejects(pool.query(`UPDATE platform.computers SET profile=jsonb_set(profile,'{runtimeImage}',to_jsonb($2::text)),revision=revision+1 WHERE id=$1`,[computer.id,to]),/identity is immutable/);
      const policy={runtimeUpdates:{[profile.id]:{from:profile.runtimeImage,to}}};
      await repo.requestAction({ownerId:owner,computerId:computer.id,action:'start',input:{expectedRevision:before.revision},key:'maintenance-start',policy});
      const next=await repo.get(owner,computer.id),op=await claim();
      for(const key of ['id','ownerId','nodeId','poolId','volumeId','firmwareId','tpmId','resources']) assert.deepEqual(next[key],before[key]);
      assert.equal(next.profile.runtimeImage,to);assert.equal(next.run.runtimeImage,to);
      assert.equal(op.command.profile.runtimeImage,to);
      assert.equal((await repo.getOperation(owner,startOp.id)).command.profile.runtimeImage,profile.runtimeImage);
      await repo.complete(op,result(op,{running:true,runId:next.run.id,runtimeImage:to,containerId:'9'.repeat(64)}));
      await assert.rejects(pool.query(`UPDATE platform.computers SET profile=jsonb_set(profile,'{mediaDigest}',to_jsonb($2::text)),revision=revision+1 WHERE id=$1`,[computer.id,to]),/identity is immutable/);
      const running=await repo.get(owner,computer.id);
      await repo.requestAction({ownerId:owner,computerId:computer.id,action:'shutdown',input:{expectedRevision:running.revision},key:'maintenance-stop'});
      const stop=await claim();
      await repo.complete(stop,result(stop,{stopped:true,cleanShutdown:true,runId:running.run.id,containerId:running.run.containerId}),{releaseResources:async()=>{}});
    });
    await t.test('a repeated delete request returns its original completion after the computer is gone',async()=>{
      const current=await repo.get(owner,computer.id),args={ownerId:owner,computerId:computer.id,action:'delete',input:{expectedRevision:current.revision,confirmDelete:true},key:'delete-1'};
      await repo.requestAction(args);const op=await claim(),proof=result(op,{dataDeleted:true});
      await repo.complete(op,proof,{releaseResources:async()=>{}});
      assert.equal((await repo.complete(op,proof)).state,'succeeded');
      assert.equal((await repo.requestAction(args)).id,op.id);
      assert.deepEqual(await repo.list(owner),[]);
    });
    await t.test('verified capacity refusal completes a failed operation and allows a fresh start request',async()=>{
      await create('create-after-delete');const provision=await claim();
      await repo.complete(provision,result(provision,{provisioned:true,encryption:'luks2'}));
      const c=await repo.get(owner,provision.computerId),args={ownerId:owner,computerId:c.id,action:'start',input:{expectedRevision:c.revision},key:'capacity-start'};
      await repo.requestAction(args);const op=await claim(),proof=result(op,{rejected:true,noSideEffects:true,errorCode:'computer_capacity_unavailable'});
      await assert.rejects(repo.complete(op,proof),{code:'computer_capacity_unavailable'});
      let releases=0;assert.equal((await repo.complete(op,proof,{releaseResources:async()=>{releases++;}})).state,'failed');
      assert.equal((await repo.requestAction(args)).state,'failed');assert.equal(releases,1);
      const stopped=await repo.get(owner,c.id);assert.equal(stopped.run,null);assert.equal(stopped.state,'stopped');
      await repo.requestAction({...args,key:'capacity-retry',input:{expectedRevision:stopped.revision}});
      const retry=await claim();assert.ok(retry.id!==op.id);
      await repo.complete(retry,result(retry,{rejected:true,noSideEffects:true,errorCode:'computer_capacity_unavailable'}),{releaseResources:async()=>{}});
    });
    await t.test('concurrent sparse disks and CPU/RAM settings do not advance-book shared capacity',async()=>{
      const GiB=1024**3,clock=Date.now();
      await pool.query(`UPDATE compute.nodes SET capacity=$2 WHERE id=$1`,[node,{cpuMillis:16000,unifiedMemoryBytes:128*GiB,
        acceleratorUnits:0,codecSessions:0,storageBytes:500*GiB,networkBitsPerSecond:1000000000}]);
      const baseline={nodeId:node,nodeGeneration:1,poolId:'test-pool',encryption:'luks2',sampledAt:clock,volumes:[],storageOverheadBytes:2*GiB,storageReserveBytes:0,
        freeStorageBytes:208*GiB,memoryAvailableBytes:34*GiB,freeCpuCount:16,kvm:true,memoryPressure:false,swapOutActive:false,
        workers:[],availableCpuGroups:[[0,1,2,3,4,5,6,7],[8,9,10,11,12,13,14,15]]};
      const capacity=new PostgresComputerCapacity({ localNodeId: node,database,clock:()=>clock,baselineProvider:{async read(){return structuredClone(baseline);}},
        installedNodes:[{nodeId:node,poolId:'test-pool',profileIds:[profile.id],policy:{qemuOverheadBytes:2*GiB,gatewayOverheadBytes:GiB,
          storageReserveBytes:0,storageOverheadBytes:2*GiB,maximumSampleAgeMs:10000}}]});
      const add=async(who,key,diskGiB)=>{const i={...input,resources:{...input.resources,diskGiB}};
        const placement=await capacity.placement({input:i,policy:{}});return repo.requestCreate({ownerId:who,input:i,key,placement});};
      const creates=await Promise.allSettled([add(owner,'shared-a',128),add(other,'shared-b',128)]);
      assert.equal(creates.filter(r=>r.status==='fulfilled').length,2);
      const [firstOp,secondOp]=creates.map(r=>r.value);
      const a=await repo.get(firstOp.ownerId,firstOp.computerId);
      assert.equal((await pool.query("SELECT to_regclass('compute.computer_storage_reservations') AS retired")).rows[0].retired,null);
      for(let i=0;i<2;i++){const op=await claim();await repo.complete(op,result(op,{provisioned:true,encryption:'luks2'}));}
      const begin=async c=>{c=await repo.get(c.ownerId,c.id);const op=await repo.requestAction({ownerId:c.ownerId,computerId:c.id,action:'start',key:'shared-start-'+c.id,input:{expectedRevision:c.revision}});return {computer:await repo.get(c.ownerId,c.id),operation:op};};
      const ca=await begin(a),cb=await begin(await repo.get(secondOp.ownerId,secondOp.computerId));
      const admissions=await Promise.all([capacity.acquireRun(ca),capacity.acquireRun(cb)]);
      assert.equal(admissions.filter(r=>r.state==='active').length,2);
      assert.equal((await pool.query("SELECT to_regclass('compute.computer_resource_reservations') AS retired")).rows[0].retired,null);
      const accepted=ca;
      baseline.memoryAvailableBytes=0;baseline.memoryPressure=true;
      assert.equal((await capacity.acquireRun(accepted)).id,accepted.computer.run.id);
      baseline.memoryAvailableBytes=34*GiB;baseline.memoryPressure=false;
      const releaseResources=capacity.releaseResources.bind(capacity);
      for(let i=0;i<2;i++){const op=await claim(),current=op.computerId===ca.computer.id?ca:cb;
        await repo.complete(op,result(op,{running:true,runId:current.computer.run.id,runtimeImage:profile.runtimeImage,containerId:(i?'d':'e').repeat(64)}));}
      const running=await repo.get(accepted.computer.ownerId,accepted.computer.id);
      await repo.requestAction({ownerId:running.ownerId,computerId:running.id,action:'shutdown',key:'shared-stop',input:{expectedRevision:running.revision}});
      const stop=await claim();
      await repo.complete(stop,result(stop,{stopped:true,cleanShutdown:true,runId:running.run.id,containerId:running.run.containerId}),{releaseResources});
      assert.equal((await pool.query("SELECT * FROM compute.computer_runs WHERE state='active' AND id=ANY($1::uuid[])",[[ca.computer.run.id,cb.computer.run.id]])).rows.length,1);
      const stopped=await repo.get(running.ownerId,running.id);
      await repo.requestAction({ownerId:stopped.ownerId,computerId:stopped.id,action:'delete',key:'shared-delete',input:{expectedRevision:stopped.revision,confirmDelete:true}});
      const del=await claim();await repo.complete(del,result(del,{dataDeleted:true}),{releaseResources});
      assert.equal((await repo.get(cb.computer.ownerId,cb.computer.id)).state,'running');
    });
    await t.test('administrator policies persist without touching guests, quota changes serialize with admission',async()=>{
      const original=await repo.list(owner),base={enabled:true,maximum:{},storedPerUser:null,runningPerUser:null};
      const update={enabled:false,maximum:{vcpus:16},storedPerUser:null,runningPerUser:null,expectedRevision:0};
      await repo.setPolicy(owner,update);
      assert.equal((await repo.policy(base)).enabled,false);
      await assert.rejects(repo.setPolicy(owner,update),{code:'computer_state_conflict'});
      await assert.rejects(repo.requestCreate({ownerId:owner,input,key:'admin-paused',placement,policy:base}),{code:'computer_creation_paused'});
      assert.deepEqual(await repo.list(owner),original);
      await repo.setPolicy(owner,{...update,enabled:true,expectedRevision:1});
      await repo.setQuota(owner,other,{storedPerUser:0,runningPerUser:0,expectedRevision:0});
      assert.equal((await repo.policy(base,other)).storedPerUser,0);
      await assert.rejects(repo.requestCreate({ownerId:other,input,key:'admin-quota',placement,policy:base}),{code:'computer_stored_quota'});
      await assert.rejects(repo.setQuota(owner,other,{storedPerUser:1,runningPerUser:1,expectedRevision:0}),{code:'computer_state_conflict'});
      const page=await repo.administrationQuotas({search:'test-other'},await repo.policy(base));
      assert.equal(page.data.length,1);assert.equal(page.data[0].storedPerUser,0);
      assert.equal(page.data[0].ownerId,other);assert.equal(page.data[0].volumeId,undefined);
      const cap=new PostgresComputerCapacity({ localNodeId: node,database,installedNodes:[{nodeId:node,poolId:'test-pool',profileIds:[profile.id],policy:{}}],baselineProvider:{read:()=>{throw Error('not needed');}}});
      assert.equal((await cap.status())[0].nodeName,'test-node');
    });
    await t.test('system import and publication are immutable, repeatable and preserve all guest state',async()=>{
      const before=(await pool.query('SELECT * FROM platform.computers ORDER BY id')).rows;
      const imported=await repo.importProfile({...profile,id:'windows-next'});
      assert.equal(imported.create_enabled,false);
      assert.deepEqual(await repo.importProfile(imported.profile),imported);
      await assert.rejects(repo.importProfile({...imported.profile,version:'different'}),{code:'computer_profile_version_conflict'});
      const input={enabled:true,expectedRevision:profileRevision(imported)};
      await assert.rejects(repo.publishProfile(imported.profile.id,input,async()=>{throw Object.assign(Error(),{code:'computer_profile_not_installed'});}),{code:'computer_profile_not_installed'});
      let checked=0;
      const published=await repo.publishProfile(imported.profile.id,input,async p=>{assert.deepEqual(p,imported.profile);checked++;});
      assert.equal(checked,1);assert.equal(published.create_enabled,true);
      assert.deepEqual(await repo.importProfile(imported.profile),published);
      await assert.rejects(repo.publishProfile(imported.profile.id,input,async()=>{}),{code:'computer_state_conflict'});
      const paused=await repo.publishProfile(imported.profile.id,{enabled:false,expectedRevision:profileRevision(published)},()=>{throw Error('pausing must work offline');});
      assert.equal(paused.create_enabled,false);
      assert.deepEqual((await pool.query('SELECT * FROM platform.computers ORDER BY id')).rows,before);
    });
    await t.test('guest exits release only exact runtime reservations; offline and late results preserve data',async()=>{
      await repo.setQuota(owner,other,{storedPerUser:null,runningPerUser:null,expectedRevision:1});
      const created=await repo.requestCreate({ownerId:other,input:{...input,name:'Observed exits'},key:'observe-create',placement,policy:{enabled:true}});
      let op=await claim();assert.equal(op.id,created.id);await repo.complete(op,result(op,{provisioned:true,encryption:'luks2'}));
      let c=await repo.get(other,created.computerId);
      const disk={volumeId:c.volumeId,firmwareId:c.firmwareId,tpmId:c.tpmId};
      async function start(){
        const requested=await repo.requestAction({ownerId:other,computerId:c.id,action:'start',key:'observe-start-'+c.revision,input:{expectedRevision:c.revision},policy:{enabled:true}});
        const op=await claim();assert.equal(requested.id,op.id);c=await repo.get(other,c.id);
        await pool.query(`INSERT INTO compute.computer_runs(id,computer_id,owner_id,node_id,node_generation,generation,memory_bytes,cpu_millis,cpu_ids)
          VALUES($1,$2,$3,$4,1,$5,$6,2000,'[0,1]')`,[c.run.id,c.id,c.ownerId,c.nodeId,c.generation,10*2**30]);
        return op;
      }
      op=await start();
      await repo.complete(op,result(op,{running:true,runId:c.run.id,runtimeImage:c.profile.runtimeImage,containerId:'b'.repeat(64)}));
      c=await repo.get(other,c.id);const original=structuredClone(c);
      await repo.observeRun(c,null);c=await repo.get(other,c.id);
      assert.equal(c.state,'unavailable');assert.deepEqual(c.run,original.run);
      const facts={computerId:c.id,ownerId:c.ownerId,nodeId:c.nodeId,volumeId:c.volumeId,firmwareId:c.firmwareId,tpmId:c.tpmId,
        generation:c.generation,runId:c.run.id,containerId:c.run.containerId,runtimeImage:c.profile.runtimeImage,running:true};
      assert.equal(await repo.observeRun(original,{...facts,running:false,stopped:true}),false);
      await repo.observeRun(c,facts);c=await repo.get(other,c.id);assert.equal(c.state,'running');
      await assert.rejects(repo.observeRun(c,{...facts,runId:randomUUID(),running:false,stopped:true}),{code:'computer_result_mismatch'});
      await repo.observeRun(c,{...facts,running:false,stopped:true,cleanShutdown:true});c=await repo.get(other,c.id);
      assert.equal(c.state,'stopped');assert.equal(c.run,null);assert.equal(c.errorCode,null);
      assert.equal((await pool.query('SELECT state FROM compute.computer_runs WHERE id=$1',[original.run.id])).rows[0].state,'released');
      op=await start(); // A lost start reply followed by a crash is terminal, not an infinite retry.
      await repo.observeRun(c,{...facts,generation:c.generation,runId:c.run.id,running:false,stopped:true,cleanShutdown:false});c=await repo.get(other,c.id);
      assert.equal(c.state,'stopped');assert.equal(c.errorCode,'computer_unclean_shutdown');
      assert.equal((await repo.getOperation(other,op.id)).state,'failed');
      assert.deepEqual({volumeId:c.volumeId,firmwareId:c.firmwareId,tpmId:c.tpmId},disk);
      assert.equal(await repo.observeRun(original,{...facts,running:false,stopped:true,cleanShutdown:true}),false);
    });
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }
});
