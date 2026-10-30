import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDynamicAgentRoutes} from '../src/assistant/dynamic-agent-routes.mjs';
import {dynamicSandboxIdentity} from '../../../services/agent-bridge/src/dynamic-sandbox-controller.mjs';
const OWNER='00000000-0000-4000-8000-000000000011';
async function fixture(t,fetchImplementation){const dir=await mkdtemp(join(tmpdir(),'dynamic-agent-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const tokenFile=join(dir,'token');await writeFile(tokenFile,'s'.repeat(48),{mode:0o600});
 return createDynamicAgentRoutes({origin:'http://agent-controller:8080',tokenFile,fetchImplementation});}
test('first use provisions the authenticated owner and concurrent calls coalesce',async t=>{
 let count=0;const routes=await fixture(t,async (url,options)=>{count++;assert.equal(url.pathname,`/v1/owners/${OWNER}/ensure`);assert.equal(options.method,'POST');assert.equal(options.headers.authorization,'Bearer '+'s'.repeat(48));await new Promise(r=>setTimeout(r,5));return Response.json({...dynamicSandboxIdentity(OWNER),token:'x'.repeat(48)});});
 const [a,b]=await Promise.all([routes.resolve(OWNER),routes.resolve(OWNER)]);assert.equal(count,1);assert.equal(a,b);
 await routes.resolve(OWNER);assert.equal(count,2);
});
test('invalid owner never reaches the provisioning service',async t=>{
 const routes=await fixture(t,()=>{throw Error('must not call');});await assert.rejects(routes.resolve('../admin'),{code:'agent_sandbox_unavailable'});
});
for(const variant of ['owner','origin','key','token','failure'])test(`rejects ${variant} mismatch without exposing service detail`,async t=>{
 const value={...dynamicSandboxIdentity(OWNER),token:'x'.repeat(48)};
 if(variant==='owner')value.ownerIdentityId='00000000-0000-4000-8000-000000000012';
 if(variant==='origin')value.origin='http://169.254.169.254:80';
 if(variant==='key')value.sandboxKey='sandbox.other';if(variant==='token')value.token='short';
 const routes=await fixture(t,async()=>variant==='failure'?new Response('internal detail',{status:503}):Response.json(value));
 await assert.rejects(routes.resolve(OWNER),{code:'agent_sandbox_unavailable'});
});
