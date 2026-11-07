import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PenpotTeamDirectory} from '../src/penpot-team-directory.mjs';

const url=process.env.TEAMAIBOX_PENPOT_TEST_DATABASE_URL;
test('design team mapping and current directory ceiling use explicit membership and retain data',{
  skip:!url&&'Requires an explicitly supplied empty disposable PostgreSQL database',timeout:60000,
},async t=>{
  const {default:pg}=await import('../../../packages/persistence/node_modules/pg/lib/index.js');
  const database=new pg.Pool({connectionString:url,max:8});t.after(()=>database.end());
  assert.equal((await database.query(`SELECT count(*)::int AS count FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema')`)).rows[0].count,0,'Existing data is never used');
  const migrations=new URL('../../../packages/persistence/migrations/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('manifest.json',migrations)));
  for(const row of manifest.migrations.filter(row=>row.version<=124)){
    const sql=await readFile(new URL(row.up,migrations),'utf8');
    assert.equal(createHash('sha256').update(sql).digest('hex'),row.upSha256);await database.query(sql);
  }
  const installationId=randomUUID(),teamId=randomUUID(),teamKey='team.synthetic-'+randomUUID();
  const profiles=[];
  for(let i=0;i<4;i++){
    const identityId=randomUUID(),profileId=randomUUID(),name='member-'+randomUUID();
    await database.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,
      display_name,password_hash) VALUES ($1,'local_user',$2,$2,'Synthetic member','not-a-login-hash')`,[identityId,name]);
    await database.query('INSERT INTO design.profile_mappings VALUES ($1,$2,$3)',[installationId,identityId,profileId]);
    profiles.push({identityId,profileId});
  }
  await database.query(`INSERT INTO iam.teams(id,team_key,display_name) VALUES ($1,$2,'Synthetic team')`,[teamId,teamKey]);
  const bind=async(user,role,scope='team',key=teamKey)=>database.query(`INSERT INTO iam.role_bindings
    (identity_id,role_id,scope_kind,scope_key) SELECT $1,id,$3,$4 FROM iam.roles WHERE role_key=$2`,[user.identityId,role,scope,key]);
  await bind(profiles[0],'team_admin');await bind(profiles[1],'member');await bind(profiles[2],'guest');
  await bind(profiles[3],'owner','appliance','*');
  let allowed=true;
  const directory=new PenpotTeamDirectory({database,installationId,authority:{authorizeDesign:async()=>({allowed})}});
  const context=profile=>({identityId:profile.identityId,sessionId:randomUUID()});
  const first=await Promise.all(Array.from({length:8},()=>directory.ensureMapping(context(profiles[0]),teamId)));
  assert.equal(new Set(first.map(value=>value.nativeTeamId)).size,1);
  const nativeTeamId=first[0].nativeTeamId;
  await assert.rejects(directory.ensureMapping(context(profiles[1]),teamId),{code:'penpot_team_denied'});
  await assert.rejects(directory.ensureMapping(context(profiles[3]),teamId),{code:'penpot_team_denied'});
  assert.deepEqual(await directory.list(context(profiles[3])),[]);
  assert.equal((await directory.list(context(profiles[0])))[0].nativeTeamId,null);
  await assert.rejects(directory.confirmActivation(context(profiles[1]),first[0]),{code:'penpot_team_denied'});
  await assert.rejects(directory.confirmActivation(context(profiles[0]),{teamId,nativeTeamId:randomUUID()}),{code:'penpot_team_denied'});
  await directory.confirmActivation(context(profiles[0]),first[0]);
  assert.equal((await directory.list(context(profiles[0])))[0].nativeTeamId,nativeTeamId);
  const ceiling=user=>directory.ceiling({profileId:user.profileId,teamId:nativeTeamId});
  assert.equal((await ceiling(profiles[0])).canEdit,true);assert.equal((await ceiling(profiles[1])).canEdit,true);
  assert.equal((await ceiling(profiles[2])).canEdit,false);
  await assert.rejects(ceiling(profiles[3]),{code:'penpot_team_denied'});
  await database.query(`DELETE FROM iam.role_bindings WHERE identity_id=$1 AND scope_kind='team'`,[profiles[1].identityId]);
  await assert.rejects(ceiling(profiles[1]),{code:'penpot_team_denied'});
  assert.equal((await database.query('SELECT count(*)::int AS count FROM design.team_mappings')).rows[0].count,1);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM design.profile_mappings')).rows[0].count,4);
  await database.query(`UPDATE iam.teams SET display_name='Renamed team' WHERE id=$1`,[teamId]);
  assert.equal((await directory.ensureMapping(context(profiles[0]),teamId)).nativeTeamId,nativeTeamId);
  await database.query(`UPDATE iam.teams SET status='archived' WHERE id=$1`,[teamId]);
  await assert.rejects(ceiling(profiles[0]),{code:'penpot_team_denied'});
  assert.deepEqual(await directory.list(context(profiles[0])),[]);
  assert.deepEqual(await directory.ceiling({profileId:profiles[0].profileId,teamId:randomUUID()}),
    {managed:false,canRead:true,canEdit:true});
  await database.query(`UPDATE iam.identities SET status='disabled',disabled_at=now() WHERE id=$1`,[profiles[0].identityId]);
  await assert.rejects(directory.ceiling({profileId:profiles[0].profileId,teamId:randomUUID()}));
  allowed=false;await assert.rejects(directory.list(context(profiles[2])));
  await assert.rejects(database.query(await readFile(new URL('000121_penpot_team_directory.down.sql',migrations),'utf8')));
  assert.equal((await database.query('SELECT count(*)::int AS count FROM design.team_mappings')).rows[0].count,1);
});
