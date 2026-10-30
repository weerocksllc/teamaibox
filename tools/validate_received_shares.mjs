import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const path=process.argv[2]??'evidence/validation/acceptance/received-shares-20261018-a1.json';
const evidence=JSON.parse(await readFile(path,'utf8'));
assert.equal(evidence.schemaVersion,1);assert.equal(evidence.status,'passed');
assert.equal(evidence.runId,'received-shares-20261018-a1');
assert.equal(evidence.wholeRelease,false);assert.equal(evidence.task24_6,false);
assert.deepEqual(evidence.tests,{pass:50,fail:0,skipped:0});
for(const key of ['ordinaryMember','receivedListVisible','actualFilePreview','readOnlyActions','sharedFolderNavigation','returnedToReceivedList','refreshAfterRevocationEmpty'])assert.equal(evidence.browser[key],true,key);
assert.equal(evidence.browser.nativeDownloadConfirmed,false);
assert.equal(evidence.protocol.protocol.outsiderExcluded,true);
assert.equal(evidence.protocol.protocol.viewerEdit,404);
assert.equal(evidence.protocol.protocol.revoked.newDownloadDenied,404);
assert.equal(evidence.protocol.protocol.revoked.removedFromList,true);
assert.equal(evidence.protocol.protocol.download.bytes,38);
assert.equal(evidence.protocol.protocol.download.sha256,'sha256:dfe02ee9d55b568a10400b9f9940438c087a023f928f06ce898c2903ffbad26e');
assert.equal(evidence.deployment.status,'deployed');
for(const key of ['guestRestarted','modelRestarted','hostRebooted','databaseMigration'])assert.equal(evidence.deployment[key],false);
for(const current of Object.values(evidence.deployment.current)){
 assert(evidence.running.some(row=>row.id===current.id&&row.image===current.image&&row.startedAt===current.startedAt));
}
for(const item of [...evidence.sources,...evidence.artifacts]){
 assert(!item.path.startsWith('/')&&!item.path.includes('..'));
 const actual='sha256:'+createHash('sha256').update(await readFile(resolve(item.path))).digest('hex');
 assert.equal(actual,item.sha256,item.path);
}
const preview=await readFile(evidence.artifacts.find(x=>x.path.endsWith('/file-preview.dom.txt')).path,'utf8');
assert.match(preview,/TEAM_AI_BOX_AUTHORIZED_SHARE_20261017/);
const revoked=await readFile(evidence.artifacts.find(x=>x.path.endsWith('/revoked.dom.txt')).path,'utf8');
assert.match(revoked,/暂时没有收到分享/);assert.doesNotMatch(revoked,/article "授权共享验证/);
console.log(JSON.stringify({status:'passed',runId:evidence.runId,wholeRelease:false,nativeDownload:false}));
