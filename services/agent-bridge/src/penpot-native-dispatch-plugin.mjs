import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { penpotRuntimeCredential } from './penpot-runtime-credential.mjs';
import { penpotRuntimePaths } from './penpot-runtime-config.mjs';

const refused = () => { throw new Error('The current design connection is not authorized'); };
async function privateFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.startsWith('/workspace/') || path === '/workspace') refused();
  const resolved = await realpath(path), info = await lstat(path);
  if (resolved !== path || !info.isFile() || info.isSymbolicLink() || info.size > 8192 || info.mode & 0o007) refused();
  return readFile(path);
}

const callFields=['server', 'tool', 'sessionID', 'messageID', 'callID'];
const validTarget=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
async function exchange(input,extra) {
    let key, configuration;
    try {
      configuration = await privateFile(process.env.TEAMAIBOX_PENPOT_NATIVE_CONTEXT_FILE ?? penpotRuntimePaths.context);
      const value = JSON.parse(configuration.toString('utf8'));
      if (value.enabled === false) refused();
      const endpoint = new URL(value.proofEndpoint);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search
        || endpoint.hash || endpoint.pathname !== '/internal/v1/design/call-proof') refused();
      key = await privateFile(value.bridgeTokenFile);
      const credential = penpotRuntimeCredential(value.identityId, key.toString('utf8').trim());
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credential },
        body: JSON.stringify({...Object.fromEntries(callFields.map(name => [name, input[name]])),...extra}),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); refused(); }
      let bytes = 0; const chunks = [];
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 8192) refused(); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { refused(); }
    finally { key?.fill(0); configuration?.fill(0); }
}

// Both hooks keep context local to one native invocation. The first observes
// the target but can't grant access; only dispatch after native confirmation
// can acquire a short-lived proof. No arguments or messages are changed.
export default async function PenpotNativeDispatchPlugin() {
  return {
    'mcp.tool.prepare': async (input,output) => {
      if(input.server!=='teamaibox-penpot'||input.tool!=='execute_code')return;
      const reply=await exchange(input,{prepare:true});
      if(!validTarget(reply?.target))refused();
      output.target=reply.target;
    },
    'mcp.tool.dispatch': async (input, output) => {
      if (input.server !== 'teamaibox-penpot') return;
      if(input.tool==='execute_code'&&!validTarget(input.target))refused();
      const proof=await exchange(input,input.tool==='execute_code'?{target:input.target}:{});
      if (!/^tabpc1_[A-Za-z0-9_-]{43}$/.test(proof.proof ?? '') || !Number.isSafeInteger(proof.expiresAt)
        || proof.expiresAt <= Date.now() || callFields.some(name => proof[name] !== input[name])) refused();
      output.meta = { ...output.meta, 'com.teamaibox/penpot': proof };
    },
  };
}
