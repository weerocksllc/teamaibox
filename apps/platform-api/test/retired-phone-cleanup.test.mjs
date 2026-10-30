import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {VirtualPhoneService} from '../src/virtual-phones/virtual-phone-service.mjs';
test('retired record removal never bypasses an active or uncertain run',async()=>{
 const owner=randomUUID(),id=randomUUID();let charged=true,run=null,removed=false,revoked=false;
 const repository={requestCreate(){},completeOperation(){},get:async()=>({id,ownerId:owner,revision:1,runningCharged:charged}),currentRun:async()=>run,removeRetiredRecord(){removed=true}};
 const runtime={provision(){},start(){},stop(){},deleteData(){assert.fail()},revokeAccess(){},hasConfiguredLocation:()=>false,revokeRetiredRecordAccess(){revoked=true}};
 const service=new VirtualPhoneService({repository,runtime,directory:{authorization:async()=>({permissions:['phone:use']})}});
 const request={context:{identityId:owner},phoneId:id,input:{expectedRevision:1,confirmDelete:true}};
 await assert.rejects(service.removeRetiredRecord(request),{code:'phone_stop_unconfirmed'});
 charged=false;run={id:randomUUID(),state:'unavailable'};
 await assert.rejects(service.removeRetiredRecord(request),{code:'phone_stop_unconfirmed'});
 assert.equal(removed,false);assert.equal(revoked,false);
});
