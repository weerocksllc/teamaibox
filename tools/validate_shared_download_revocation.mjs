import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const path=process.argv[2]??'evidence/validation/acceptance/shared-download-revocation-20261018-a2.json';
const e=JSON.parse(await readFile(path));
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
assert.equal(e.status,'passed');assert.equal(e.wholeRelease,false);
assert.deepEqual(e.tests,{pass:69,fail:0,skipped:0});
assert.equal(e.deployment.status,'deployed');
for(const key of ['guestRestarted','modelRestarted','hostRebooted','databaseMigration'])assert.equal(e.deployment[key],false);
for(const key of ['ordinaryMember','receivedListVisible','nativeDownloadConfirmed','nativeSaveDialogConfirmed','revokedListEmpty'])assert.equal(e.browser[key],true);
assert.equal(e.browser.download.bytes,38);
assert.equal(e.browser.download.sha256,'sha256:dfe02ee9d55b568a10400b9f9940438c087a023f928f06ce898c2903ffbad26e');
assert.deepEqual(e.protocol.references.map(r=>r.kind),['download','preview']);
for(const r of e.protocol.references){
 assert.equal(r.before.get.status,200);assert.equal(r.before.get.matchesContent,true);
 assert.equal(r.before.head.status,200);assert.equal(r.before.range.status,206);
 assert(Date.parse(r.expiresAt)>Date.parse(e.protocol.completedAt));
 for(const check of Object.values(r.after)){assert.equal(check.status,404);assert.equal(check.matchesContent,false);}
}
assert.equal(e.protocol.newDownload.status,404);assert.equal(e.protocol.removedFromList,true);assert.equal(e.protocol.ownerDownload.matchesContent,true);
assert.deepEqual(e.protocol.before,e.protocol.after);
for(const r of [...e.sources,...e.artifacts,e.failedPredecessor]){assert(!r.path.startsWith('/')&&!r.path.includes('..'));assert.equal(digest(await readFile(r.path)),r.sha256,r.path);}
const failed=JSON.parse(await readFile(e.failedPredecessor.path));assert.equal(failed.status,'failed');assert.equal(failed.revoked.oldDownloadStatus,200);
const dom=await readFile(e.artifacts.find(a=>a.path.endsWith('recipient-revoked.dom.txt')).path,'utf8');assert.match(dom,/暂时没有收到分享/);
console.log(JSON.stringify({status:'passed',runId:e.runId,nativeDownload:true,immediateRevocation:true,wholeRelease:false}));
