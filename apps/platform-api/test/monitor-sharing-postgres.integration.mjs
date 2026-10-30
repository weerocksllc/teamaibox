// Dedicated empty database only. No appliance/user records are touched.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {PostgresDatabase} from '../../../packages/persistence/src/postgres-database.mjs';
import {PostgresComputerRepository} from '../src/virtual-computers/postgres-computer-repository.mjs';
import {MonitorSharing} from '../src/virtual-computers/monitor-sharing.mjs';
import {PostgresIdentityRepository} from '../src/identity/postgres-repository.mjs';
import {RepositoryCastingIdentityDirectory} from '../src/casting/repository-casting-identity-directory.mjs';
const require=createRequire(new URL('../../../packages/persistence/package.json',import.meta.url)),{Pool}=require('pg');
assert.ok(process.env.MONITOR_SHARING_PG_PORT,'Explicit disposable database port required');
const database=new PostgresDatabase({pool:new Pool({host:'127.0.0.1',port:Number(process.env.MONITOR_SHARING_PG_PORT),user:'postgres',database:'monitor_sharing_test'})});
try{
 assert.equal((await database.query("SELECT to_regclass('platform.computers') AS existing")).rows[0].existing,null,'Fresh isolated database required');
 const root=new URL('../../../packages/persistence/migrations/',import.meta.url);
 for(const m of JSON.parse(await readFile(new URL('manifest.json',root),'utf8')).migrations)await database.transaction(db=>readFile(new URL(m.up,root),'utf8').then(sql=>db.query(sql)));
 const owner=randomUUID(),member=randomUUID(),stranger=randomUUID(),node=randomUUID(),pool='monitor-sharing-test-pool',id=randomUUID();
 for(const who of [owner,member,stranger]){
  await database.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,display_name,password_hash)
   VALUES($1::uuid,'local_user',$1::uuid::text,$1::uuid::text,'Disposable monitor test','synthetic')`,[who]);
  await database.query("INSERT INTO iam.identity_roles(identity_id,role_id) SELECT $1,id FROM iam.roles WHERE role_key='member'",[who]);
  await database.query("INSERT INTO iam.role_bindings(identity_id,role_id,scope_kind,scope_key) SELECT $1,id,'appliance','*' FROM iam.roles WHERE role_key='member'",[who]);
 }
 await database.query("INSERT INTO compute.nodes(id,node_key,architecture,trust_kind,lifecycle_state) VALUES($1,'monitor-test','aarch64','managed_appliance','ready')",[node]);
 await database.query(`INSERT INTO objects.storage_pools(pool_id,display_name,backend_kind,node_id,failure_domain,health_state,total_bytes,available_bytes,encryption_mode,encryption_status,encryption_verified_at,compatibility_status,compatibility_verified_at)
 VALUES($1,'Test only','local-block',$2,'test','healthy',1099511627776,1099511627776,'luks2','verified',clock_timestamp(),'verified',clock_timestamp())`,[pool,node]);
 const profile={id:'disposable-test'};await database.query('INSERT INTO platform.computer_profiles(id,profile) VALUES($1,$2)',[profile.id,profile]);
 await database.query(`INSERT INTO platform.computers(id,owner_id,node_id,pool_id,profile_id,volume_id,firmware_id,name,state,revision,generation,profile,resources,run)
 VALUES($1,$2,$3,$4,$5,$6,$7,'Sharing test computer','running',1,1,$8,'{}',$9)`,[id,owner,node,pool,profile.id,randomUUID(),randomUUID(),profile,{id:randomUUID(),containerId:'synthetic-not-a-guest'}]);
 const repository=new PostgresComputerRepository({database}),directory=new RepositoryCastingIdentityDirectory({repository:new PostgresIdentityRepository({database})});
 const make=()=>new MonitorSharing({database,directory,repository});let service=make();
 const context=identityId=>({identityId,sessionId:'test-'+identityId});
 const before=await repository.get(owner,id);
 await assert.rejects(service.resolve({context:context(member),computerId:id}),{code:'computer_not_found'});
 await service.update(context(owner),id,{identityId:member,permission:'view'});
 assert.equal((await service.invitations(context(member))).data[0].name,'Sharing test computer');
 assert.equal((await service.invitations(context(stranger))).data.length,0);
 assert.equal((await service.resolve({context:context(member),computerId:id,running:true})).monitorRole,'view');
 await assert.rejects(service.grants(context(member),id),{code:'computer_permission_required'});
 await assert.rejects(service.update(context(member),id,{identityId:stranger,permission:'control'}),{code:'computer_permission_required'});
 await assert.rejects(repository.get(member,id),{code:'computer_not_found'}); // no lifecycle/ownership expansion
 service=make();assert.equal((await service.grants(context(owner),id)).data[0].permission,'view');
 await service.update(context(owner),id,{identityId:member,permission:'control'});
 assert.equal((await service.resolve({context:context(member),computerId:id})).monitorRole,'control');
 await database.query("UPDATE iam.identities SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1",[member]);
 await assert.rejects(service.resolve({context:context(member),computerId:id}),{code:'computer_permission_required'});
 await service.update(context(owner),id,{identityId:member,permission:null});
 assert.equal((await service.grants(context(owner),id)).data.length,0);
 assert.deepEqual(await repository.get(owner,id),before,'Invitations must not mutate the guest');
 console.log('PASS PostgreSQL invite / received list / view-control role / owner-only changes / persistence / disabled-account denial / revoke / unchanged guest');
}finally{await database.close();}
