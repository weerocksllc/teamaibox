import test from 'node:test';
import assert from 'node:assert/strict';
import {PenpotReadiness} from '../../../apps/platform-api/src/design/penpot-readiness.mjs';
import {PenpotHandoffHttpApi} from '../../../apps/platform-api/src/design/penpot-handoff-http-api.mjs';
import {readFile} from 'node:fs/promises';
import {ApplicationCatalogService} from '../../../apps/platform-api/src/applications/application-catalog-service.mjs';
import {CompositeApplicationRouteSource} from '../../../apps/platform-api/src/applications/composite-application-route-source.mjs';

function fixture(){
 const calls=[];let allowed=true,backendReady=true,exporterReady=false;
 const authentication={authenticateSession:async input=>{assert.equal(input.requireCsrf,true);return {identityId:'synthetic'};}};
 const authority={authorizeDesign:async()=>({allowed})};
 const config={authentication,authority,frontendOrigin:'http://editor.example',backendOrigin:'http://backend.example',exporterOrigin:'http://exporter.example',mcpConfigured:false,
   fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return new Response('',{status:url.hostname==='exporter.example'&&!exporterReady||url.hostname==='backend.example'&&!backendReady?503:200,headers:{'content-type':'text/html'}});}};
 return {config,calls,set allowed(v){allowed=v;},set backendReady(v){backendReady=v;},set exporterReady(v){exporterReady=v;}};
}
test('exporter or AI absence does not block manual editing; observations recover without restarting services',async()=>{
 const f=fixture(),service=new PenpotReadiness(f.config);
 let status=await service.inspect({});assert.equal(status.editor,'ready');assert.equal(status.dependencies.exporter,'unavailable');assert.equal(status.aiTransport,'not_configured');
 f.backendReady=false;status=await service.inspect({});assert.equal(status.editor,'unavailable');
 f.backendReady=true;f.exporterReady=true;status=await service.inspect({});assert.equal(status.editor,'ready');assert.equal(status.dependencies.exporter,'ready');
 assert.ok(f.calls.every(c=>c.options.redirect==='error'&&!c.options.headers.authorization&&c.options.signal));
 assert.doesNotMatch(JSON.stringify(status),/https?:|password|token/);
});
test('unauthorized callers never probe; revocation while observing refuses the response',async()=>{
 const f=fixture(),service=new PenpotReadiness(f.config);f.allowed=false;
 await assert.rejects(service.inspect({}),{code:'penpot_access_denied'});assert.equal(f.calls.length,0);
 f.allowed=true;const original=f.config.fetchImpl;
 const after=new PenpotReadiness({...f.config,fetchImpl:async(...args)=>{const response=await original(...args);f.allowed=false;return response;}});
 await assert.rejects(after.inspect({}),{code:'penpot_access_denied'});
});
test('fixed target and empty body contract; no raw upstream exception disclosed',async()=>{
 const f=fixture();assert.throws(()=>new PenpotReadiness({...f.config,frontendOrigin:'http://user:secret@editor.example'}));
 const service=new PenpotReadiness({...f.config,fetchImpl:async()=>{throw Error('private upstream details');}});
 const api=new PenpotHandoffHttpApi({handoff:{issue(){},redeem(){}},readiness:service});
 assert.ok(api.matches('POST','/api/v1/design/status'));assert.ok(!api.isPrivate('/api/v1/design/status'));
 await assert.rejects(api.handle({pathname:'/api/v1/design/status',body:{origin:'http://other.example'}}),{code:'invalid_request'});
 const result=await api.handle({pathname:'/api/v1/design/status',body:{}});assert.equal(result.body.editor,'unavailable');assert.doesNotMatch(JSON.stringify(result),/private upstream/);
});

test('installed native Design is launchable through its protected route, never the generic plugin proxy',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../../../deploy/applications/penpot.release-template.json',import.meta.url)));
 const f=fixture(),clock=()=>new Date('2026-01-02T00:00:00Z');
 const readiness=new PenpotReadiness({...f.config,version:manifest.version,clock});
 const plugin={pluginKey:manifest.id,pluginType:'application',currentVersion:manifest.version,manifest,
   lifecycleState:'enabled',installState:'healthy',slotState:'active',activeSlot:'blue',slotHealth:{healthy:false}};
 const repository={getApplication:async()=>plugin,snapshot:async()=>({plugins:[plugin],capabilities:[],
   health:[{targetKind:'core_service',targetKey:'object-service',state:'healthy',observedAt:clock().toISOString()}]})};
 const routeSource=new CompositeApplicationRouteSource({sources:[{routes:async()=>[await readiness.catalogRoute()]}]});
 const catalog=new ApplicationCatalogService({repository,routeSource,clock});
 const context={permissions:['application:catalog:view','design:use']};
 let app=(await catalog.list({context})).applications[0];
 assert.equal(app.launchable,true);assert.equal(app.route.pathPrefix,'/api/v1/design/editor/');
 assert.deepEqual(app.blockers,[]); // exporter down and no MCP do not block manual design
 assert.equal(await catalog.resolveProxyRoute({context,pluginKey:manifest.id}),null);
 assert.equal(await catalog.fetchProxyContent({context,pluginKey:manifest.id,method:'GET',path:'/plugins/official.penpot'}),null);
 f.backendReady=false;app=(await catalog.list({context})).applications[0];
 assert.equal(app.launchable,false);assert.ok(app.blockers.includes('plugin_unhealthy'));
 f.backendReady=true;assert.equal((await catalog.list({context})).applications[0].launchable,true);
 app=(await catalog.list({context:{permissions:['application:catalog:view']}})).applications[0];
 assert.equal(app.launchable,false);assert.ok(app.blockers.includes('authorization_denied'));
 plugin.currentVersion='2.18.4';assert.equal((await catalog.list({context})).applications[0].launchable,false);
 assert.equal(await new PenpotReadiness(f.config).catalogRoute(),null);
 assert.doesNotMatch(JSON.stringify(await readiness.catalogRoute()),/example|secret|token/);
});
