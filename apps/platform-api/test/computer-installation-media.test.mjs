import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateComputerProfile} from '../src/virtual-computers/lifecycle.mjs';
import {mediaImportInput, installationActionInput, requireMountableMedia, initialInstallation,
  requestDiscBoot, observeDiscBoot} from '../src/virtual-computers/installation-media.mjs';
import {beginInstallationAction,completeInstallationAction} from '../src/virtual-computers/computer-installation-state.mjs';

test('a new optical retry clears the previous capacity refusal without changing the computer',()=>{
  const computer={id:randomUUID(),ownerId:randomUUID(),generation:0,state:'stopped',run:null};
  const media={id:randomUUID(),ownerId:computer.ownerId,state:'ready',compatibility:'arm64',digest:'sha256:'+'b'.repeat(64),size:4};
  const before={...initialInstallation(),errorCode:'computer_capacity_unavailable'};
  const operationId=randomUUID();
  const next=beginInstallationAction(computer,before,'mount',{expectedRevision:1,mediaId:media.id},{operationId,media});
  assert.equal(next.installation.errorCode,null);
  const operation={id:operationId,ownerId:computer.ownerId,computerId:computer.id,generation:0,command:{installation:next.command,run:null}};
  const completed=completeInstallationAction(computer,next.installation,operation,{operationId,installationRevision:2,mediaDigest:media.digest,mediaReady:true});
  assert.equal(completed.errorCode,null);assert.equal(completed.observedMediaId,media.id);
  assert.equal(before.errorCode,'computer_capacity_unavailable');assert.equal(computer.state,'stopped');
});

test('new Windows/Linux profiles have no installer digest; old fixed-media schema is unchanged', () => {
  const old = {id:'test',name:'Windows',version:'1',edition:'test',runtimeImage:'sha256:'+'a'.repeat(64),
    mediaDigest:'sha256:'+'b'.repeat(64),firmwareDigest:'sha256:'+'c'.repeat(64),driverDigest:'sha256:'+'d'.repeat(64),
    minimum:{vcpus:2,memoryGiB:4,diskGiB:64},tpm:true,secureBoot:true,remoteDesktop:true,rights:{activationRequired:true}};
  assert.deepEqual(validateComputerProfile(old), old);
  assert.throws(() => validateComputerProfile({...old, mediaDigest:null}));
  for (const osFamily of ['windows', 'linux']) {
    const profile={...old,schemaVersion:2,osFamily,architecture:'aarch64',mediaDigest:null,driverDigest:null};
    assert.deepEqual(validateComputerProfile(profile), profile);
    assert.throws(() => validateComputerProfile({...profile,architecture:'x86_64'}));
  }
});
test('import sources pin a version and reject paths, URLs and ambiguous input', () => {
  const input={source:'drive',name:'system.iso',fileId:randomUUID(),version:3};
  assert.deepEqual(mediaImportInput(input),input);
  for (const changes of [{version:0},{version:'latest'},{referenceId:randomUUID()},{path:'/host/system.iso'},{name:'../disk'}])
    assert.throws(() => mediaImportInput({...input,...changes}));
  const upload={source:'upload',name:'system.iso',referenceId:randomUUID()};
  assert.deepEqual(mediaImportInput(upload),upload);
});
test('mount requires owner, readiness and known compatible or explicitly unverified media', () => {
  const ownerId=randomUUID(), media={id:randomUUID(),ownerId,state:'ready',compatibility:'arm64',digest:'sha256:'+'a'.repeat(64),size:2**34};
  assert.equal(requireMountableMedia(media, ownerId), media); // No artificial ISO size cap.
  assert.throws(() => requireMountableMedia(media,randomUUID()),{code:'computer_media_not_found'});
  for(const compatibility of ['invalid','not-bootable','wrong-architecture'])
    assert.throws(() => requireMountableMedia({...media,compatibility},ownerId,{allowUnverified:true}));
  assert.throws(() => requireMountableMedia({...media,compatibility:'unverified'},ownerId),{code:'computer_media_confirmation_required'});
  requireMountableMedia({...media,compatibility:'unverified'},ownerId,{allowUnverified:true});
  assert.throws(() => requireMountableMedia({...media,state:'preparing'},ownerId));
});
test('media actions cannot smuggle restart, force-eject or disk identities', () => {
  const input={expectedRevision:2,mediaId:randomUUID()};
  assert.equal(installationActionInput('mount',input).allowUnverified,false);
  for(const addition of [{force:true},{restart:true},{volumeId:randomUUID()},{device:'system'}])
    assert.throws(() => installationActionInput('mount',{...input,...addition}));
  assert.throws(() => installationActionInput('eject',input));
});
test('one-time boot is generation-bound and a consumed request cannot be replayed', () => {
  const mediaId=randomUUID(), operationId=randomUUID();
  const initial={...initialInstallation(),desiredMediaId:mediaId,observedMediaId:mediaId};
  const request={operationId,nextGeneration:2};
  const pending=requestDiscBoot(initial,request);
  const armed=observeDiscBoot(pending,{operationId,generation:2,state:'armed'});
  const consumed=observeDiscBoot(armed,{operationId,generation:2,state:'consumed'});
  assert.deepEqual(requestDiscBoot(consumed,request),consumed);
  assert.deepEqual(observeDiscBoot(consumed,{operationId,generation:2,state:'armed'}),consumed);
  assert.throws(() => observeDiscBoot(pending,{operationId,generation:3,state:'consumed'}));
  assert.throws(() => requestDiscBoot(pending,{...request,operationId:randomUUID()}));
  assert.equal(initial.boot,null);
});
