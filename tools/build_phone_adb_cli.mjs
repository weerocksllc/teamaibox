// Offline release assembly using the workspace's already installed bundler.
// Output contains ws, so users need only Node.js and standard Android adb.
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const require=createRequire(import.meta.resolve('../apps/web/node_modules/vite/package.json'));
const {rolldown}=await import(require.resolve('rolldown'));
const bundle=await rolldown({input:fileURLToPath(new URL('../apps/platform-api/tools/phone-adb.mjs',import.meta.url)),platform:'node',
  external:['bufferutil','utf-8-validate'],
});
try {await bundle.write({format:'esm',file:fileURLToPath(new URL('../apps/virtual-phones-plugin/src/public/phone-adb-cli.mjs',import.meta.url)),
  banner:'// Team AI Box phone ADB relay. Includes ws (MIT); see phone-adb-NOTICE.txt.\nimport { createRequire as _phoneRequire } from "node:module";\nconst require = _phoneRequire(import.meta.url);'});
} finally {await bundle.close();}
