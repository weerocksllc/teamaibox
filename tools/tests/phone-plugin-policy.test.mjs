import test from 'node:test';
import assert from 'node:assert/strict';
import {phonePluginPolicy} from '../../deploy/appliance/phone-plugin-policy.mjs';
test('phone plugin adds only the existing encrypted-object capability and owner phone scope',()=>{
 const runtime={capabilities:['object-references','nvidia-container-runtime'],node:{nodeGeneration:5},applicationIngress:{networkName:'plugin-ingress'}};
 const policy={permissions:{allowedPlatformApiScopes:['files:read'],maximumScopes:64},supplyChain:{maximumCriticalFindings:0,maximumHighFindings:0}};
 const next=phonePluginPolicy(runtime,policy);
 assert.deepEqual(next.runtime,{...runtime,capabilities:[...runtime.capabilities,'encrypted-objects']});
 assert.deepEqual(next.policy,{...policy,permissions:{...policy.permissions,allowedPlatformApiScopes:['files:read','phone:use']}});
 assert.deepEqual(runtime.capabilities,['object-references','nvidia-container-runtime']);
 assert.deepEqual(policy.permissions.allowedPlatformApiScopes,['files:read']);
});
test('unexpected configuration cannot silently expand capabilities',()=>{
 assert.throws(()=>phonePluginPolicy({capabilities:[]},{permissions:{allowedPlatformApiScopes:[]}}));
 assert.throws(()=>phonePluginPolicy({capabilities:['object-references','nvidia-container-runtime']},{permissions:{allowedPlatformApiScopes:['phone:use']}}));
});

