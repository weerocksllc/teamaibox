import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { PenpotLoginHandoff } from '../../../services/plugin-runtime/src/penpot-login-handoff.mjs';
import { PenpotPlatformAuthority } from '../../../services/plugin-runtime/src/penpot-platform-authority.mjs';
import { PenpotTeamDirectory } from '../../../services/plugin-runtime/src/penpot-team-directory.mjs';
import { PostgresPenpotHandoffRepository } from '../../../services/plugin-runtime/src/postgres-penpot-handoff-repository.mjs';
import { PenpotHandoffHttpApi } from '../src/design/penpot-handoff-http-api.mjs';
import { PenpotEditorGateway } from '../src/design/penpot-editor-gateway.mjs';
import { PenpotMcpHttpApi } from '../src/design/penpot-mcp-http-api.mjs';
import { PenpotMcpGateway } from '../src/design/penpot-mcp-gateway.mjs';
import { PenpotReadiness } from '../src/design/penpot-readiness.mjs';
import { PenpotNativeSourceExporter } from '../src/design/penpot-native-source-exporter.mjs';
import { PenpotDriveOutput } from '../src/design/penpot-drive-output.mjs';
import { PenpotDriveHttpApi } from '../src/design/penpot-drive-http-api.mjs';
import { PenpotDriveImporter } from '../src/design/penpot-drive-importer.mjs';
import { PenpotDriveInput } from '../src/design/penpot-drive-input.mjs';
import { penpotDerivedObjectAccess } from '../src/design/penpot-derived-object-access.mjs';
import { PenpotNativePermissions } from '../../../services/plugin-runtime/src/penpot-native-permissions.mjs';
import { PenpotConnectionAuthority } from '../../../services/plugin-runtime/src/penpot-connection-authority.mjs';
import { PostgresPenpotConnectionRepository } from '../../../services/plugin-runtime/src/postgres-penpot-connection-repository.mjs';
import { PenpotNativeCallVerifier } from '../../../services/plugin-runtime/src/penpot-native-call-verifier.mjs';
import { PenpotCallProofs } from '../../../services/plugin-runtime/src/penpot-call-proof.mjs';
import { PenpotEditorDispatches } from '../../../services/plugin-runtime/src/penpot-editor-dispatch.mjs';
import { PostgresPenpotCallRepository, PostgresPenpotEditorRepository } from '../../../services/plugin-runtime/src/postgres-penpot-call-repository.mjs';

async function secret(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Design secret file must be absolute');
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256 || metadata.mode & 0o007) {
    throw new TypeError('Design secret file must be private and bounded');
  }
  const bytes = await readFile(path);
  try {
    const value = bytes.toString('utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) {
      throw new TypeError('Design secret must encode 32 random bytes');
    }
    return value;
  } finally { bytes.fill(0); }
}

/** Optional dependency: caller isolates setup failure from platform startup. */
export async function createPenpotRuntime({ environment, database, authentication, agentRoutes, teamDrive, objectService, artifactProvenance }) {
  const keys = ['PLATFORM_PENPOT_INSTALLATION_ID', 'PLATFORM_PENPOT_TOKEN_PEPPER_FILE', 'PLATFORM_PENPOT_BACKEND_KEY_FILE'];
  if (!keys.some(key => environment[key])) return null;
  if (!database?.query || keys.some(key => !environment[key])) throw new TypeError('Incomplete design identity configuration');
  const pepper = Buffer.from(await secret(environment.PLATFORM_PENPOT_TOKEN_PEPPER_FILE), 'base64url');
  let authority;
  try {
    const backendKey = await secret(environment.PLATFORM_PENPOT_BACKEND_KEY_FILE);
    authority = new PenpotPlatformAuthority({ database,
      installationId: environment.PLATFORM_PENPOT_INSTALLATION_ID, tokenPepper: pepper });
    const teamDirectory = new PenpotTeamDirectory({database,authority,
      installationId:environment.PLATFORM_PENPOT_INSTALLATION_ID});
    const handoff = new PenpotLoginHandoff({ authentication,
      repository: new PostgresPenpotHandoffRepository({ database }),
      installationId: environment.PLATFORM_PENPOT_INSTALLATION_ID, tokenPepper: pepper,
      backendKey,
      authorizeDesign: (context, now) => authority.authorizeDesign(context, now),
      loadSession: (identityId, sessionId, now) => authority.loadSession(identityId, sessionId, now),
    });
    const frontendOrigin = environment.PLATFORM_PENPOT_FRONTEND_ORIGIN;
    const backendOrigin = environment.PLATFORM_PENPOT_BACKEND_ORIGIN;
    if (Boolean(frontendOrigin) !== Boolean(backendOrigin)) throw new TypeError('Incomplete design service configuration');
    const nativePermissions = backendOrigin ? new PenpotNativePermissions({ backendOrigin, backendKey,
      teamCeiling:input=>teamDirectory.ceiling(input) }) : null;
    let mcpApi = null, mcpGateway = null;
    if (environment.PLATFORM_PENPOT_MCP_KEY_FILE) {
      try {
        const serviceKey = await secret(environment.PLATFORM_PENPOT_MCP_KEY_FILE);
        const connections = new PenpotConnectionAuthority({
          repository: new PostgresPenpotConnectionRepository({ database }), platform: authority, routes: agentRoutes,
          nativePermissions,
        });
        const resolveCurrentBinding = identityId => connections.resolveCurrentBinding(identityId);
        const authenticateRuntime = credential => connections.authenticateRuntime(credential);
        const verifier = new PenpotNativeCallVerifier({ routes: agentRoutes, authenticateRuntime, resolveBinding: resolveCurrentBinding });
        const proofRepository = new PostgresPenpotCallRepository({ database });
        const deliveryRepository = new PostgresPenpotEditorRepository({ database });
        const proofs = new PenpotCallProofs({ repository: {
          async insert(row) {
            await proofRepository.discardExpired(Date.now());
            await deliveryRepository.discardExpired(Date.now());
            await proofRepository.insert(row);
          },
          consume: input => proofRepository.consume(input),
        }, authority: { verifyNativeCall: (auth, call) => verifier.verify(auth, call),
          authenticateMcp: authenticateRuntime, resolveCurrentBinding } });
        const dispatches = new PenpotEditorDispatches({ proofs, repository: deliveryRepository, nativePermissions,
          authenticateEditor: input => authority.authenticateNativeSession(input) });
        mcpApi = new PenpotMcpHttpApi({ connections, proofs, dispatches, serviceKey });
        mcpGateway = new PenpotMcpGateway({ serviceKey, connections, platform: authority,
          websocketOrigin: environment.PLATFORM_PENPOT_MCP_WEBSOCKET_ORIGIN,
          pluginAssetsDirectory: environment.PLATFORM_PENPOT_MCP_PLUGIN_DIRECTORY });
      } catch {
        // An AI-only configuration failure must not disable manual editing.
        mcpApi?.close(); mcpApi = null; mcpGateway?.close(); mcpGateway = null;
      }
    }
    let driveApi=null,importer=null;
    if(nativePermissions&&teamDrive&&objectService?.createObjectHandoffGateway&&artifactProvenance){
      const nativeExporter=new PenpotNativeSourceExporter({backendOrigin,frontendOrigin,nativePermissions});
      const objectGateway=objectService.createObjectHandoffGateway();
      const output=new PenpotDriveOutput({database,teamDrive,objectGateway,
        provenanceService:artifactProvenance,nativeExporter});
      const driveInput=new PenpotDriveInput({teamDrive,objectGateway});
      importer=new PenpotDriveImporter({database,backendOrigin,backendKey,driveInput});
      driveApi=new PenpotDriveHttpApi({authority,nativeExporter,output,importer,driveInput,nativePermissions});
      objectService.setDesignReadAuthorization?.(penpotDerivedObjectAccess({database,teamDirectory,nativePermissions}));
    }
    const editor = frontendOrigin ? new PenpotEditorGateway({ authority, handoff, frontendOrigin, backendOrigin, mcpGateway,
      collaboration:nativePermissions,driveApi }) : null;
    const readiness=new PenpotReadiness({authentication,authority,frontendOrigin,backendOrigin,
      exporterOrigin:environment.PLATFORM_PENPOT_EXPORTER_ORIGIN,mcpConfigured:Boolean(mcpApi&&mcpGateway),
      version:environment.PLATFORM_PENPOT_VERSION??null});
    return Object.freeze({ authority, handoff, editor, mcpApi, readiness, httpApi: new PenpotHandoffHttpApi({ handoff, readiness,
      teams:nativePermissions ? {directory:teamDirectory,native:nativePermissions,authentication,backendKey,importer} : null }),
      close: () => { mcpGateway?.close(); mcpApi?.close(); editor?.close(); authority.close(); } });
  } catch (error) { authority?.close(); throw error; }
  finally { pepper.fill(0); }
}
