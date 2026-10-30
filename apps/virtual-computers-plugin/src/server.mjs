import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createStaticApplicationPluginServer} from '../../../packages/application-plugin-runtime/src/static-server.mjs';
import metadata from '../package.json' with {type:'json'};

export function createVirtualComputersPluginServer() {
  return createStaticApplicationPluginServer({pluginId:'official.virtual-computers',version:metadata.version,
    publicRoot:resolve(dirname(fileURLToPath(import.meta.url)),'public')});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  createVirtualComputersPluginServer().listen(Number.parseInt(process.env.PORT||'8080',10),'0.0.0.0');
}
