// Read-only production catalog probe. No server startup, registration or reconciliation.
import { readFile } from 'node:fs/promises';
import { createPostgresDatabaseFromEnvironment } from '/opt/teamaibox/packages/persistence/src/postgres-database.mjs';
import { PostgresManagedNodeRepository } from '/opt/teamaibox/services/scheduler/src/postgres-managed-node-repository.mjs';
import { ManagedNodeAgentRouter } from '/opt/teamaibox/services/scheduler/src/managed-node-agent-router.mjs';
import { ProtectedNodeAgentClient } from '/opt/teamaibox/services/scheduler/src/protected-node-agent-client.mjs';
import { NodeAgentHttpsTransport } from '/opt/teamaibox/services/scheduler/src/node-agent-https-transport.mjs';
import { HmacNodeAgentCommandSigner } from '/opt/teamaibox/services/scheduler/src/node-agent-command-signer.mjs';
import { NodeAgentWorkerSpecFactory } from '/opt/teamaibox/services/scheduler/src/node-agent-worker-spec-factory.mjs';
import { createApplianceProtectedOfficeRuntime } from '/opt/teamaibox/apps/platform-api/server/appliance-protected-office-runtime.mjs';
import { ProtectedOfficeCatalogRepository, protectedOfficeCatalogProfiles } from '/opt/teamaibox/apps/platform-api/src/applications/protected-office-catalog-repository.mjs';
import { PostgresApplicationCatalogRepository } from '/opt/teamaibox/apps/platform-api/src/applications/postgres-application-catalog-repository.mjs';
import { ApplicationCatalogService } from '/opt/teamaibox/apps/platform-api/src/applications/application-catalog-service.mjs';
import { FileApplicationRouteSource } from '/opt/teamaibox/apps/platform-api/src/applications/file-application-route-source.mjs';
import { FileBuiltInApplicationSource } from '/opt/teamaibox/apps/platform-api/src/applications/file-built-in-application-source.mjs';
import { CompositeApplicationRouteSource } from '/opt/teamaibox/apps/platform-api/src/applications/composite-application-route-source.mjs';
import { createPluginRuntimeFromEnvironment } from '/opt/teamaibox/apps/platform-api/server/plugin-runtime.mjs';
const env=process.env, database=await createPostgresDatabaseFromEnvironment(env);
let pluginRuntime;
try{
  const nodeId=env.PLATFORM_APPLIANCE_NODE_ID;
  const [ca,certificate,privateKey,keyFile]=await Promise.all(['CA','CERT','KEY','COMMAND_KEY'].map(k=>readFile(env[`PLATFORM_APPLIANCE_${k}_FILE`])));
  const key=Buffer.from(keyFile.toString().trim(),'base64');
  const nodeRepository=new PostgresManagedNodeRepository({database,localNodeId:nodeId});
  const nodeAgentRouter=new ManagedNodeAgentRouter({nodeRepository,localNodeId:nodeId,connectorFactory:async route=>new ProtectedNodeAgentClient({
    nodeId,nodeGeneration:route.nodeGeneration,allowRetainedRuntime:route.allowRetainedRuntime===true,
    transport:new NodeAgentHttpsTransport({host:env.PLATFORM_APPLIANCE_AGENT_HOST||'127.0.0.1',port:Number(env.PLATFORM_APPLIANCE_AGENT_PORT||9443),
      expectedServerName:route.expectedServerName,expectedCertificateFingerprint:route.expectedCertificateFingerprint,ca,certificate,privateKey}),
    commandSigner:new HmacNodeAgentCommandSigner({keyId:env.PLATFORM_APPLIANCE_COMMAND_KEY_ID||'scheduler-persistent-v1',key}),workerSpecFactory:new NodeAgentWorkerSpecFactory()})});
  const runtime=createApplianceProtectedOfficeRuntime(env,{nodeRepository,nodeAgentRouter});
  const repository=new ProtectedOfficeCatalogRepository({database,runtime,profiles:protectedOfficeCatalogProfiles(env),setId:env.PLATFORM_PROTECTED_OFFICE_SET_ID,nodeId,
    repository:new PostgresApplicationCatalogRepository({database,routingPolicyKey:env.PLATFORM_MODEL_ROUTING_POLICY_KEY||'production.default',environment:env.PLATFORM_MODEL_ROUTING_ENVIRONMENT||'production'})});
  // Construct the read-only route source, but deliberately never start recovery
  // or call lifecycle/import/administration methods in this diagnostic process.
  if(env.TEAMAIBOX_BOOT_PROBE_ALL==='1')pluginRuntime=await createPluginRuntimeFromEnvironment(env,{database});
  const service=new ApplicationCatalogService({repository,drawingProfile:{profileId:env.DRAWING_PROFILE_ID,profileKey:env.DRAWING_PROFILE_KEY},
    routeSource:new CompositeApplicationRouteSource({sources:[new FileApplicationRouteSource({path:env.PLATFORM_APPLICATION_ROUTES_FILE,readinessFetcher:fetch}),...(pluginRuntime?[pluginRuntime.applicationRouteSource]:[])]}),
    builtInSource:new FileBuiltInApplicationSource({path:env.PLATFORM_BUILT_IN_APPLICATIONS_FILE})});
  const catalog=await service.list({context:{permissions:['application:catalog:view','ai:invoke','file:read','file:write','job:read','job:write','object:read','object:write','model:view','phone:use','computer:use']}});
  const included=a=>a.ui.categoryKey==='ai-application'||(env.TEAMAIBOX_BOOT_PROBE_ALL==='1'&&['official.virtual-computers','official.virtual-phones','official.wireless-casting'].includes(a.pluginKey));
  console.log(JSON.stringify({observedAt:new Date().toISOString(),readOnly:true,applications:catalog.applications.filter(included).map(a=>({pluginKey:a.pluginKey,launchable:a.launchable,startupState:a.startupState,blockers:a.blockers}))}));
  key.fill(0);privateKey.fill(0);
}finally{pluginRuntime?.close();await database.close();}
