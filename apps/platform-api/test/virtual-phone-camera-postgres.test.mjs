import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import {PostgresDatabase} from '../../../packages/persistence/src/postgres-database.mjs';
import {PostgresPhoneCameraRepository} from '../src/virtual-phones/postgres-phone-camera-repository.mjs';
import {cameraStartInput} from '../src/virtual-phones/phone-camera-contracts.mjs';
import {PostgresPhoneUsbCameraPolicy} from '../src/virtual-phones/phone-usb-camera-policy.mjs';
import {PostgresPhoneUdpCameraPolicy} from '../src/virtual-phones/phone-udp-camera-policy.mjs';

const {Pool}=createRequire(new URL('../../../packages/persistence/package.json',import.meta.url))('pg');
const exec=promisify(execFile),docker=async(...args)=>(await exec('docker',args,{timeout:120000,maxBuffer:2**20})).stdout.trim();
const root=new URL('../../../packages/persistence/migrations/',import.meta.url);
const postgresImage=process.env.TEAMAIBOX_TEST_PHONE_POSTGRES_IMAGE
  ||'sha256:83b9631dbb4121d9235ef910018272798b7d3041ef5b716aa481122d4c49353f';
const fixedPostgresPort=process.env.TEAMAIBOX_TEST_PHONE_CAMERA_POSTGRES_PORT
  ? Number(process.env.TEAMAIBOX_TEST_PHONE_CAMERA_POSTGRES_PORT):null;
if(fixedPostgresPort!==null&&(!Number.isInteger(fixedPostgresPort)||fixedPostgresPort<1024||fixedPostgresPort>65535))
  throw new Error('TEAMAIBOX_TEST_PHONE_CAMERA_POSTGRES_PORT must be an unprivileged TCP port');
test('camera metadata real PostgreSQL: additive schema, exact binding, concurrency and revocation',{
  skip:process.env.TEAMAIBOX_TEST_PHONE_POSTGRES!=='1',timeout:180000,
},async t=>{
  const name='teamaibox-phone-camera-pg-'+randomUUID();let cid,db;
  try{
    cid=await docker('run','-d','--name',name,'--label','teamaibox.phone-test='+name,'--memory=512m','--memory-swap=512m','--cpus=1','--pids-limit=128',
      '--mount','type=tmpfs,destination=/var/lib/postgresql,tmpfs-size=536870912','-p',`127.0.0.1:${fixedPostgresPort??''}:5432`,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=phone_test',
      postgresImage);
    assert.match(cid,/^[a-f0-9]{64}$/);const port=fixedPostgresPort??Number((await docker('port',cid,'5432/tcp')).split(':').at(-1));
    db=new PostgresDatabase({pool:new Pool({host:'127.0.0.1',port,user:'postgres',database:'phone_test',max:8,connectionTimeoutMillis:2000})});
    for(let i=0;;i++){try{await db.ready();break;}catch(e){if(i===59)throw e;await new Promise(r=>setTimeout(r,250));}}
    const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
    for(const m of manifest.migrations.filter(x=>x.version<=82))await db.transaction(async tx=>tx.query(await readFile(new URL(m.up,root),'utf8')));
    const ownerId=randomUUID(),other=randomUUID(),sessionId=randomUUID(),otherSession=randomUUID(),nodeId=randomUUID(),phoneId=randomUUID(),runId=randomUUID();
    for(const [who,session,n] of [[ownerId,sessionId,1],[other,otherSession,2]]){
      await db.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,display_name,password_hash)
        VALUES($1::uuid,'local_user',$1::text,$1::text,'camera fixture','synthetic-hash')`,[who]);
      await db.query(`INSERT INTO iam.sessions(id,identity_id,token_hash,csrf_hash,password_version,user_agent_hash,network_hash,
        created_at,last_seen_at,idle_expires_at,expires_at) VALUES($1,$2,$3,$3,1,$3,$3,clock_timestamp(),clock_timestamp(),
        clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '10 minutes')`,[session,who,Buffer.alloc(32,n)]);
    }
    await db.query(`INSERT INTO compute.nodes(id,node_key,architecture,trust_kind,lifecycle_state) VALUES($1,'camera-fixture','aarch64','managed_appliance','ready')`,[nodeId]);
    await db.query(`INSERT INTO objects.storage_pools(pool_id,display_name,backend_kind,node_id,failure_domain,health_state,total_bytes,available_bytes,
      encryption_mode,encryption_status,encryption_verified_at,compatibility_status,compatibility_verified_at)
      VALUES('camera-test-pool','synthetic encrypted fixture','local-block',$1,'fixture','healthy',1099511627776,1099511627776,
      'luks2','verified',clock_timestamp(),'verified',clock_timestamp())`,[nodeId]);
    // Synthetic DB capability is not a claim that an actual product ROM is verified.
    await db.query(`INSERT INTO platform.phone_rom_versions(id,family_id,display_name,version_label,base_build_id,runtime_image_digest,
      google_play,experimental,camera_capability) VALUES('camera-test-v1','aosp','fixture','fixture','16102939',$1,false,true,'verified')`,['sha256:'+'c'.repeat(64)]);
    await db.query(`INSERT INTO platform.phones(id,owner_id,name,state,generation,spec_id,base_build_id,node_id,pool_id,volume_id,storage_bytes,running_charged,rom_version_id)
      VALUES($1,$2,'camera fixture','running',1,'cuttlefish-arm64-office-v1','16102939',$3,'camera-test-pool',$4,17179869184,true,'camera-test-v1')`,[phoneId,ownerId,nodeId,randomUUID()]);
    await db.query(`INSERT INTO platform.phone_runs(id,phone_id,owner_id,generation,node_id,node_generation,reservation_id,image_digest,state,memory_bytes,cpu_millis)
      VALUES($1,$2,$3,1,$4,1,$5,$6,'running',6442450944,2000)`,[runId,phoneId,ownerId,nodeId,randomUUID(),'sha256:'+'c'.repeat(64)]);
    const saved=async()=>({phones:(await db.query('SELECT to_jsonb(p) AS v FROM platform.phones p ORDER BY id')).rows,
      reservations:(await db.query('SELECT * FROM compute.phone_resource_reservations ORDER BY run_id')).rows});
    const before=await saved(),migration=async direction=>db.transaction(async tx=>tx.query(await readFile(new URL(`000083_phone_camera_inputs.${direction}.sql`,root),'utf8')));
    await t.test('empty up/down/up changes neither phones nor existing resource reservations',async()=>{
      await migration('up');await migration('down');await migration('up');assert.deepEqual(await saved(),before);
    });
    const repository=new PostgresPhoneCameraRepository({database:db});
    const identity={ownerId,phoneId,sessionId,generation:1};
    const source={kind:'image',continueWithoutViewer:true,file:{objectId:randomUUID(),objectVersion:1,name:'fixture.png',sizeBytes:5,sha256:'a'.repeat(64)}};
    const args=async(requestId=randomUUID())=>({...await repository.assertSelected(identity),...cameraStartInput({expectedGeneration:1,requestId,source})});
    let value;
    await t.test('concurrent sources reserve exactly one slot; an identical retry has no second producer',async()=>{
      const a=await args(),b=await args(),results=await Promise.allSettled([repository.reserve(a),repository.reserve(b)]);
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'phone_operation_conflict');
      value=results.find(x=>x.status==='fulfilled').value;const retry=await repository.reserve(value.sourceId===a.sourceId?a:b);
      assert.equal(retry.id,value.id);assert.equal(retry.created,false);
      await assert.rejects(repository.reserve({...a,sourceId:value.sourceId,source:{...source,file:{...source.file,objectVersion:2}}}),{code:'phone_idempotency_conflict'});
    });
    await t.test('foreign owner/session, old generation and different runtime cannot reserve',async()=>{
      for(const change of [{ownerId:other,sessionId:otherSession},{sessionId:otherSession},{generation:2}])await assert.rejects(repository.assertSelected({...identity,...change}));
      await assert.rejects(repository.reserve({...await args(),runId:randomUUID()}),{code:'phone_stale_run'});
      for(const column of ['owner_id','run_id','session_id'])await assert.rejects(db.query(`UPDATE platform.phone_camera_inputs SET ${column}=$2 WHERE id=$1`,[value.id,randomUUID()]),{code:'23514'});
    });
    await t.test('activation cannot race past stop and stopped history cannot be revived or rolled back',async()=>{
      await repository.beginStop({ownerId,phoneId,id:value.id});await assert.rejects(repository.activate(value),{code:'phone_camera_source_stopped'});
      await repository.confirmStopped(value);await repository.confirmStopped(value);assert.equal(await repository.current(identity),null);
      await assert.rejects(db.query(`UPDATE platform.phone_camera_inputs SET state='active',stopped_at=NULL WHERE id=$1`,[value.id]),{code:'23514'});
      await assert.rejects(migration('down'),{code:'23514'});assert.deepEqual(await saved(),before);
    });
    await t.test('USB policy migration, current-node selection, two-phone exclusion and revoke fencing',async()=>{
      const migrate=async direction=>db.transaction(async tx=>tx.query(await readFile(new URL(`000084_phone_usb_camera_policy.${direction}.sql`,root),'utf8')));
      await migrate('up');await migrate('down');await migrate('up');assert.deepEqual(await saved(),before);
      const usbRepo=new PostgresPhoneCameraRepository({database:db,usbEnabled:true}),policy=new PostgresPhoneUsbCameraPolicy({database:db});
      const deviceId=randomUUID(),secondPhone=randomUUID(),secondRun=randomUUID();
      await db.query(`INSERT INTO platform.phones(id,owner_id,name,state,generation,spec_id,base_build_id,node_id,pool_id,volume_id,storage_bytes,running_charged,rom_version_id)
        VALUES($1,$2,'second fixture','running',1,'cuttlefish-arm64-office-v1','16102939',$3,'camera-test-pool',$4,17179869184,true,'camera-test-v1')`,[secondPhone,other,nodeId,randomUUID()]);
      await db.query(`INSERT INTO platform.phone_runs(id,phone_id,owner_id,generation,node_id,node_generation,reservation_id,image_digest,state,memory_bytes,cpu_millis)
        VALUES($1,$2,$3,1,$4,1,$5,$6,'running',6442450944,2000)`,[secondRun,secondPhone,other,nodeId,randomUUID(),'sha256:'+'c'.repeat(64)]);
      const baseline=await saved(),second={ownerId:other,sessionId:otherSession,phoneId:secondPhone,generation:1};
      const usbArgs=async(who=identity,id=deviceId)=>({...await usbRepo.assertSelected(who),...cameraStartInput({expectedGeneration:1,requestId:randomUUID(),
        source:{kind:'usb',deviceId:id,attachmentId:'d'.repeat(64),continueWithoutViewer:true}})});
      const config=input=>policy.configure({nodeId,deviceId,actorId:ownerId,input});
      assert.deepEqual(await policy.listAllowed({nodeId,ownerId}),[]);
      await assert.rejects(usbRepo.reserve(await usbArgs()),{code:'phone_camera_usb_permission_required'});
      await config({enabled:true,ownerIds:[ownerId],expectedRevision:0});
      await assert.rejects(config({enabled:true,ownerIds:[other],expectedRevision:0}),{code:'phone_state_conflict'});
      await assert.rejects(usbRepo.reserve(await usbArgs(second)),{code:'phone_camera_usb_permission_required'});
      await assert.rejects(usbRepo.reserve(await usbArgs(identity,randomUUID())),{code:'phone_camera_usb_permission_required'});
      // The member-supplied node field is never used; the phone's run decides.
      const selected=await usbArgs();selected.nodeId=randomUUID();const own=await usbRepo.reserve(selected);
      assert.equal(own.usbNodeId,nodeId);await usbRepo.activate(own);
      await config({enabled:false,ownerIds:[],expectedRevision:1});
      assert.equal((await usbRepo.get(own.id)).authorized,false);
      assert.equal((await usbRepo.listStates({ownerId,phones:[{id:phoneId,generation:1}]}))[0].state,'stopping');
      await usbRepo.beginStop({ownerId,phoneId,id:own.id});
      await config({enabled:true,ownerIds:[ownerId,other],expectedRevision:2});
      assert.equal((await usbRepo.get(own.id)).authorized,false,'re-enabling never revives old revision');
      await assert.rejects(usbRepo.reserve(await usbArgs(second)),{code:'phone_camera_usb_busy'},'stopping producer still owns device');
      await usbRepo.confirmStopped(own);
      const a=await usbArgs(),b=await usbArgs(second),results=await Promise.allSettled([usbRepo.reserve(a),usbRepo.reserve(b)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.find(r=>r.status==='rejected').reason.code,'phone_camera_usb_busy');
      const winner=results.find(r=>r.status==='fulfilled').value;
      const selectedArgs=winner.phoneId===phoneId?a:b;
      assert.equal((await usbRepo.reserve(selectedArgs)).id,winner.id,'same exact request retains its original claim');
      await usbRepo.activate(winner);
      await assert.rejects(db.query("UPDATE platform.phone_camera_inputs SET usb_device_id=$2 WHERE id=$1",[winner.id,randomUUID()]),{code:'23514'});
      await config({enabled:true,ownerIds:[],expectedRevision:3});
      assert.equal((await usbRepo.get(winner.id)).authorized,false);
      await usbRepo.beginStop(winner);await usbRepo.confirmStopped(winner);
      await config({enabled:true,ownerIds:[ownerId,other],expectedRevision:4});
      const valid={kind:'usb',deviceId,attachmentId:'d'.repeat(64),continueWithoutViewer:true};
      for(const source of [{...valid,attachmentId:null},{...valid,continueWithoutViewer:null},{...valid,path:'/dev/video0'},
        {kind:'usb',deviceId,continueWithoutViewer:true}]){
        await assert.rejects(db.query(`INSERT INTO platform.phone_camera_inputs
          (id,source_id,phone_id,owner_id,run_id,generation,session_id,source_kind,source_config,request_fingerprint,state,usb_node_id,usb_device_id,usb_policy_revision)
          VALUES($1,$2,$3,$4,$5,1,$6,'usb',$7,$8,'starting',$9,$10,5)`,
          [randomUUID(),randomUUID(),phoneId,ownerId,runId,sessionId,source,'f'.repeat(64),nodeId,deviceId]),{code:'23514'});
      }
      await assert.rejects(migrate('down'),{code:'23514'});
      assert.deepEqual(await saved(),baseline,'policy and capture never change phone/resource allocation');
      // Keep second phone history (FKs require it), but exclude it from the
      // original test's identity comparison; no product data is touched.
      Object.assign(before,baseline);
    });
    await t.test('UDP additive migration, explicit owner/node, port contention and revision revocation',async()=>{
      // Exercise all intervening migrations against actual phone/input history.
      for(const m of manifest.migrations.filter(x=>x.version>84&&x.version<99))await db.transaction(async tx=>tx.query(await readFile(new URL(m.up,root),'utf8')));
      const baseline=await saved(),migrate=async direction=>db.transaction(async tx=>tx.query(await readFile(new URL(`000099_phone_udp_camera_policy.${direction}.sql`,root),'utf8')));
      await migrate('up');await migrate('down');await migrate('up');assert.deepEqual(await saved(),baseline);
      const repo=new PostgresPhoneCameraRepository({database:db,udpEnabled:true}),policy=new PostgresPhoneUdpCameraPolicy({database:db});
      const policyId=randomUUID(),config={name:'Camera stream',enabled:true,listenAddress:'10.64.0.19',listenPort:24100,allowedSources:['192.168.0.0/16'],ownerIds:[ownerId],expectedRevision:0};
      const configure=input=>policy.configure({nodeId,policyId,actorId:ownerId,input});
      const make=async(who=identity,revision=1)=>({...await repo.assertSelected(who),...cameraStartInput({expectedGeneration:1,requestId:randomUUID(),source:{kind:'udp',policyId,policyRevision:revision,continueWithoutViewer:true}})});
      await assert.rejects(repo.reserve(await make()),{code:'phone_camera_udp_permission_required'});
      await configure(config);await assert.rejects(configure(config),{code:'phone_state_conflict'});
      const secondRow=(await db.query('SELECT id FROM platform.phones WHERE owner_id=$1',[other])).rows[0];
      const second={ownerId:other,sessionId:otherSession,phoneId:secondRow.id,generation:1};
      await assert.rejects(repo.reserve(await make(second)),{code:'phone_camera_udp_permission_required'});
      await configure({...config,ownerIds:[ownerId,other],expectedRevision:1});
      const a=await make(identity,2),b=await make(second,2),results=await Promise.allSettled([repo.reserve(a),repo.reserve(b)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.find(r=>r.status==='rejected').reason.code,'phone_camera_udp_port_unavailable');
      const winner=results.find(r=>r.status==='fulfilled').value;
      assert.equal(winner.udpNodeId,nodeId);assert.deepEqual(winner.udpPolicy,{listenAddress:config.listenAddress,listenPort:config.listenPort,allowedSources:config.allowedSources});
      await repo.activate(winner);assert.equal((await repo.get(winner.id)).authorized,true);
      await assert.rejects(db.query('UPDATE platform.phone_camera_inputs SET udp_policy_revision=99 WHERE id=$1',[winner.id]),{code:'23514'});
      await configure({...config,enabled:false,ownerIds:[],expectedRevision:2});assert.equal((await repo.get(winner.id)).authorized,false);
      await configure({...config,ownerIds:[ownerId,other],expectedRevision:3});assert.equal((await repo.get(winner.id)).authorized,false);
      await repo.beginStop(winner);await repo.confirmStopped(winner);
      const next=await repo.reserve(await make(identity,4));await repo.activate(next);await repo.beginStop(next);await repo.confirmStopped(next);
      await assert.rejects(migrate('down'),{code:'23514'});assert.deepEqual(await saved(),baseline);
      Object.assign(before,baseline);
    });
    await t.test('revoked login invalidates active source without changing the phone or charge',async()=>{
      value=await repository.reserve(await args());await repository.activate(value);assert.equal((await repository.get(value.id)).authorized,true);
      const summary=await repository.listStates({ownerId,phones:[{id:phoneId,generation:1}]});
      assert.deepEqual(summary,[{phoneId,generation:1,sourceId:value.sourceId,sourceKind:'image',state:'active'}]);
      assert.deepEqual(await repository.listStates({ownerId:other,phones:[{id:phoneId,generation:1}]}),[]);
      assert.deepEqual(await repository.listStates({ownerId,phones:[{id:phoneId,generation:2}]}),[]);
      await db.query("UPDATE iam.sessions SET revoked_at=clock_timestamp(),revoke_reason='test sign out' WHERE id=$1",[sessionId]);
      assert.equal((await repository.listStates({ownerId,phones:[{id:phoneId,generation:1}]}))[0].state,'stopping');
      assert.equal((await repository.get(value.id)).authorized,false);await repository.beginStop({ownerId,phoneId,sessionId});await repository.confirmStopped(value);
      assert.deepEqual(await saved(),before);
    });
  }finally{
    await db?.close();if(cid){const inspected=JSON.parse(await docker('inspect',cid))[0];assert.equal(inspected.Config.Labels['teamaibox.phone-test'],name);
      assert.equal(inspected.Name,'/'+name);await docker('rm','-f',cid);assert.equal(await docker('ps','-aq','--filter','label=teamaibox.phone-test='+name),'');}
  }
});
