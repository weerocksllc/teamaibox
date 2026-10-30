import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {ProtectedNodeAgentClient} from '../../../services/scheduler/src/protected-node-agent-client.mjs';
import {phoneMediaGrant} from '../../../services/scheduler/src/android-phone-media-command.mjs';

test('all media command deadlines leave clock margin below the unchanged node ceiling',async()=>{
  const now=Date.now(),nodeId=randomUUID(),id=randomUUID(),seen=[];
  const payload={phoneId:randomUUID(),ownerId:randomUUID(),volumeId:randomUUID(),poolId:'phone-test-encrypted',baseBuildId:'16102939',
    operationId:id,generation:1,run:{id:randomUUID(),reservationId:randomUUID(),imageDigest:'sha256:'+'a'.repeat(64),memoryBytes:6*1024**3,cpuMillis:2000},
    grantId:id,sessionId:randomUUID(),kind:'control',leaseExpiresAt:now+4000};
  const check=raw=>{
    const e=JSON.parse(raw);seen.push(e);
    assert.equal(Date.parse(e.deadlineAt)-Date.parse(e.issuedAt),4000);
    for(const offset of [-750,-5,0,5,750]) {
      const nodeNow=now+offset;
      assert.ok(Date.parse(e.deadlineAt)>nodeNow && Date.parse(e.deadlineAt)<=nodeNow+5000);
      if(e.payload.leaseExpiresAt)assert.ok(e.payload.leaseExpiresAt>nodeNow && e.payload.leaseExpiresAt<=nodeNow+5000);
    }
    return e;
  };
  const client=new ProtectedNodeAgentClient({nodeId,nodeGeneration:3,clock:()=>new Date(now),
    commandSigner:{async sign(){return {keyId:'fixture',nonce:'fixture',signature:'fixture'};}},workerSpecFactory:{buildStartPayload(){}},
    transport:{async postCommand({body}){const e=check(body),closing=e.type.endsWith('.close');return {...e,status:'succeeded',
      payload:{...phoneMediaGrant(e.payload),...(closing?{peerClosed:true}:{peerOpen:true,leaseExpiresAt:e.payload.leaseExpiresAt})}};},
      async openPhoneSignal({body}){check(body);return {close(){}};},async openPhoneADB({body}){check(body);return {destroy(){}};}}});
  for(const action of ['open','renew','close']){
    const p={...payload};if(action==='close')delete p.leaseExpiresAt;
    await client.executePhoneMedia({action,payload:p,correlationId:'clock-fixture'});
  }
  await client.connectPhoneSignal({payload,correlationId:'clock-fixture'});
  await client.connectPhoneADB({payload:{...payload,kind:'adb'},correlationId:'clock-fixture'});
  assert.equal(seen.length,5);
});
