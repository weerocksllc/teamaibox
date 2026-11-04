// Local isolated acceptance only: the real Bridge and filesystem implementation.
import {createOpenCodeBridgeHttpServer} from '../../../../services/agent-bridge/src/opencode-bridge-http-server.mjs';
import {createOpenCodeAdapter} from '../../../../services/agent-bridge/src/opencode-adapter-registry.mjs';
import {OPEN_CODE_V119_COMPATIBILITY} from '../../../../services/agent-bridge/src/opencode-adapter-v1-19.mjs';
const adapter=createOpenCodeAdapter({...OPEN_CODE_V119_COMPATIBILITY,origin:'http://127.0.0.1:4096',credentialProvider:async()=>({username:'opencode',password:process.env.SYNTHETIC_NATIVE_CREDENTIAL})});
createOpenCodeBridgeHttpServer({adapter,workspace:'/workspace',tokenProvider:async()=>process.env.SYNTHETIC_BRIDGE_CREDENTIAL}).listen(4102,'0.0.0.0');
