// Explicitly opt-in live UI probe: creates only a new disabled identity and a
// new test group. Never edits or clears an existing conversation.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresDatabaseFromEnvironment} from '../packages/persistence/src/postgres-database.mjs';
import {PostgresMessagingRepository} from '../services/messaging/src/postgres-repository.mjs';
import {MessagingService} from '../services/messaging/src/messaging-service.mjs';
const [mode,ownerId,conversationId]=process.argv.slice(2);
assert.ok(['seed-disposable','verify-disposable','discard-disposable'].includes(mode));
assert.match(ownerId,/^[0-9a-f-]{36}$/);
const database=await createPostgresDatabaseFromEnvironment();
try {
  const service=new MessagingService({repository:new PostgresMessagingRepository({database}),attachmentVerifier:{resolveAttachment(){},issueDownloadReference(){}}});
  const context={actorIdentityId:ownerId,actorKind:'local_user',permissions:['message:read','message:write']};
  const title='清理流程专用测试 20261022';
  if(mode==='seed-disposable') {
    assert.equal((await database.query('SELECT count(*)::int AS n FROM iam.identities WHERE id=$1 AND status=\'active\'',[ownerId])).rows[0].n,1);
    const other=randomUUID(),login=`cleanup-ui-${other}`;
    await database.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,display_name,status,disabled_at)
      VALUES($1,'service_account',$2,$2,'可丢弃清理测试对端','disabled',clock_timestamp())`,[other,login]);
    const c=await service.createConversation(context,{kind:'group',title,participantIdentityIds:[ownerId,other]});
    for(let n=1;n<=3;n++)await service.sendMessage(context,c.id,{content:`专用测试消息 ${n}，可以删除。`,idempotencyKey:`cleanup-ui-${n}-${c.id}`});
    console.log(JSON.stringify({conversationId:c.id,otherId:other,title}));
  } else {
    const c=(await database.query('SELECT title,created_by_identity_id FROM platform.messaging_conversations WHERE id=$1',[conversationId])).rows[0];
    assert.equal(c?.title,title);assert.equal(c.created_by_identity_id,ownerId);
    const participants=(await database.query('SELECT identity_id FROM platform.messaging_participants WHERE conversation_id=$1',[conversationId])).rows;
    const result={ownerHistory:(await service.history(context,conversationId)).length,
      listed:(await service.listConversations(context,{limit:200})).some(c=>c.id===conversationId),
      otherHistory:(await service.history({...context,actorIdentityId:participants.find(x=>x.identity_id!==ownerId).identity_id},conversationId)).length};
    console.log(JSON.stringify(result));
    if(mode==='discard-disposable') {
      assert.equal(result.ownerHistory,0);assert.equal(result.listed,false);assert.equal(participants.length,2);
      const otherId=participants.find(x=>x.identity_id!==ownerId).identity_id;
      await database.transaction(async db=>{
        const other=(await db.query('SELECT * FROM iam.identities WHERE id=$1 FOR UPDATE',[otherId])).rows[0];
        assert.equal(other.identity_kind,'service_account');assert.equal(other.status,'disabled');
        assert.equal(other.normalized_login_name,`cleanup-ui-${otherId}`);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM platform.messaging_participants WHERE identity_id=$1',[otherId])).rows[0].n,1);
        const removed=await db.query('DELETE FROM platform.messaging_conversations WHERE id=$1 AND title=$2 AND created_by_identity_id=$3 RETURNING id',[conversationId,title,ownerId]);
        assert.equal(removed.rows.length,1);
        await db.query('DELETE FROM iam.identities WHERE id=$1',[otherId]);
      });
      console.log('DISCARDED only this newly seeded test conversation and disabled test identity');
    }
  }
}finally{await database.close();}
