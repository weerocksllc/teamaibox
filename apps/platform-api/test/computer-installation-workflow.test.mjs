import test from 'node:test';
import assert from 'node:assert/strict';
import {ComputerInstallationWorkflow} from '../src/virtual-computers/computer-installation-workflow.mjs';

test('create-and-install resumes durable steps without recreating or restarting a running guest',async()=>{
  const computer={id:'new-only',ownerId:'owner',state:'stopped',revision:2};
  const installation={autoStart:true,revision:1,desiredMediaId:'iso',observedMediaId:null,boot:null};
  const calls=[];
  const repository={installationFollowups:async()=>installation.autoStart?[computer]:[],getInstallation:async()=>structuredClone(installation),
    finishInstallationFollowup:async(owner,id,revision,error)=>{assert.equal(revision,installation.revision);installation.autoStart=false;installation.errorCode=error;},
    requestInstallation:async request=>{calls.push(request);assert.equal(request.automatic,true);
      if(request.action==='mount')installation.observedMediaId='iso';else installation.boot={state:'pending'};installation.revision++;},
    requestAction:async request=>{calls.push(request);computer.state='starting';}};
  const options={repository,directory:{authorization:async()=>({permissions:['computer:use']})},policyProvider:async()=>({enabled:true})};
  await new ComputerInstallationWorkflow(options).runOnce();
  await new ComputerInstallationWorkflow(options).runOnce(); // API process replacement
  await new ComputerInstallationWorkflow(options).runOnce();
  await new ComputerInstallationWorkflow(options).runOnce(); // not another start
  assert.deepEqual(calls.map(c=>c.action),['mount','boot-disc','start']);
  computer.state='running';await new ComputerInstallationWorkflow(options).runOnce();
  assert.equal(installation.autoStart,false);
  await new ComputerInstallationWorkflow(options).runOnce();assert.equal(calls.length,3);
});

test('revoked authorization and consumed boot do not silently launch again',async()=>{
  for(const permissions of [[],['computer:use']]) {
    let code;
    const repository={installationFollowups:async()=>[{id:'new-only',ownerId:'owner',state:'stopped'}],
      getInstallation:async()=>({autoStart:true,revision:9,desiredMediaId:'iso',observedMediaId:'iso',boot:{state:'consumed'}}),
      finishInstallationFollowup:async(o,id,r,c)=>{code=c;},requestAction:()=>assert.fail('must not restart')};
    await new ComputerInstallationWorkflow({repository,directory:{authorization:async()=>({permissions})}}).runOnce();
    assert.equal(code,permissions.length?'computer_installation_boot_unconfirmed':'computer_permission_required');
  }
});
