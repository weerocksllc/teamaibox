import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PenpotTeamDirectory} from '../src/penpot-team-directory.mjs';
import {PenpotHandoffHttpApi} from '../../../apps/platform-api/src/design/penpot-handoff-http-api.mjs';

const url=process.env.TEAMAIBOX_PENPOT_TEST_DATABASE_URL;
test('Penpot role projection follows the platform directory and protects the private callback',{
  skip:!url&&'Requires an explicitly supplied empty disposable PostgreSQL database',timeout:60000,
},async t=>{
  const {default:pg}=await import('../../../packages/persistence/node_modules/pg/lib/index.js');
  const database=new pg.Pool({connectionString:url,max:4});t.after(()=>database.end());
  assert.equal((await database.query(`SELECT count(*)::int AS count FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema')`)).rows[0].count,0,'Existing data is never used');
  const migrations=new URL('../../../packages/persistence/migrations/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('manifest.json',migrations)));
  for(const row of manifest.migrations.filter(row=>row.version<=124)){
    const sql=await readFile(new URL(row.up,migrations),'utf8');
    assert.equal(createHash('sha256').update(sql).digest('hex'),row.upSha256);await database.query(sql);
  }
  const installationId=randomUUID(),teamId=randomUUID(),teamKey='team.synthetic-'+randomUUID();
  const profiles=[0,1,2].map(()=>({identityId:randomUUID(),profileId:randomUUID(),sessionId:randomUUID()}));
  for(const p of profiles){
    await database.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,display_name,password_hash)
      VALUES ($1,'local_user',$2,$2,'Synthetic member','fixture')`,[p.identityId,'member-'+p.identityId]);
    await database.query('INSERT INTO design.profile_mappings VALUES ($1,$2,$3)',[installationId,p.identityId,p.profileId]);
  }
  const [founder,member,outsider]=profiles;
  await database.query(`INSERT INTO iam.teams(id,team_key,display_name) VALUES ($1,$2,'Synthetic team')`,[teamId,teamKey]);
  const grant=(p,role,scope='team',key=teamKey)=>database.query(`INSERT INTO iam.role_bindings(identity_id,role_id,scope_kind,scope_key)
    SELECT $1,id,$3,$4 FROM iam.roles WHERE role_key=$2`,[p.identityId,role,scope,key]);
  await grant(founder,'team_admin');await grant(member,'member');await grant(outsider,'owner','appliance','*');
  let clock=new Date();
  const directory=new PenpotTeamDirectory({database,installationId,clock:()=>clock,authority:{authorizeDesign:async()=>({allowed:true})}});
  const backendKey=randomBytes(32).toString('base64url'),calls=[];
  let revokeDuringActivation=false;
  const api=new PenpotHandoffHttpApi({handoff:{issue(){},redeem(){}},teams:{directory,backendKey,native:{
    async ensureTeam(input){
      calls.push(input);
      if(calls.length===1)throw Error('synthetic lost activation reply');
      if(revokeDuringActivation)await database.query("DELETE FROM iam.role_bindings WHERE identity_id=$1 AND scope_kind='team'",[founder.identityId]);
    },
  },authentication:{async authenticateSession({sessionToken,csrfToken,requireCsrf}){
    assert.equal(requireCsrf,true);assert.equal(csrfToken,'valid');return profiles.find(p=>p.sessionId===sessionToken);
  }}}});
  const teams=(p,body)=>api.handle({pathname:'/api/v1/design/teams',sessionToken:p.sessionId,csrfToken:'valid',body});
  await assert.rejects(teams(outsider,{teamId}),{status:403});
  await assert.rejects(teams(member,{teamId}),{status:403});
  await assert.rejects(teams(founder,{teamId}),/lost activation reply/);
  assert.equal((await teams(member,{})).body.teams[0].nativeTeamId,null);
  const {body:mapping}=await teams(founder,{teamId});
  assert.deepEqual(calls,[0,1].map(()=>({profileId:founder.profileId,teamId:mapping.nativeTeamId,name:'Synthetic team'})));
  assert.equal((await teams(member,{})).body.teams[0].nativeTeamId,mapping.nativeTeamId);
  const activation=manifest.migrations.find(row=>row.version===124);
  const down=await readFile(new URL(activation.down,migrations),'utf8');
  assert.equal(createHash('sha256').update(down).digest('hex'),activation.downSha256);
  await database.query(down);
  assert.equal((await database.query('SELECT native_team_id FROM design.team_mappings')).rows[0].native_team_id,mapping.nativeTeamId);
  await database.query(await readFile(new URL(activation.up,migrations),'utf8'));
  assert.equal((await teams(member,{})).body.teams[0].nativeTeamId,null);
  revokeDuringActivation=true;
  await assert.rejects(teams(founder,{teamId}),{status:403});
  assert.equal((await teams(member,{})).body.teams[0].nativeTeamId,null);
  revokeDuringActivation=false;
  await grant(founder,'team_admin');
  assert.deepEqual((await teams(founder,{teamId})).body,mapping);
  const roles=(profile,headers)=>api.handle({pathname:'/internal/v1/design/team-roles',body:{profileId:profile.profileId},headers});
  const authorized={authorization:'Bearer '+backendKey};
  await assert.rejects(roles(member,{...authorized,origin:'https://example.invalid'}),{status:403});
  await assert.rejects(roles(member,{authorization:'Bearer '+randomBytes(32).toString('base64url')}),{status:403});
  assert.deepEqual((await roles(member,authorized)).body.memberships,[{teamId:mapping.nativeTeamId,role:'editor'}]);
  assert.deepEqual((await roles(outsider,authorized)).body.memberships,[]);
  await database.query(`UPDATE iam.role_bindings SET role_id=(SELECT id FROM iam.roles WHERE role_key='guest')
    WHERE identity_id=$1 AND scope_kind='team'`,[member.identityId]);
  assert.deepEqual((await roles(member,authorized)).body.memberships,[{teamId:mapping.nativeTeamId,role:'viewer'}]);
  await database.query(`UPDATE iam.role_bindings SET expires_at=now()+interval '1 minute'
    WHERE identity_id=$1 AND scope_kind='team'`,[member.identityId]);
  clock=new Date(Date.now()+120_000);
  assert.deepEqual((await roles(member,authorized)).body.memberships,[]);
  await database.query(`UPDATE iam.teams SET status='archived' WHERE id=$1`,[teamId]);
  assert.deepEqual((await roles(founder,authorized)).body.memberships,[]);
});
