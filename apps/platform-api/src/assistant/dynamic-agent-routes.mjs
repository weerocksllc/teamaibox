import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PlatformError } from '../../../../packages/observability/src/index.mjs';
import { OpenCodeBridgeClient } from '../../../../services/agent-bridge/src/opencode-bridge-client.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = () => new PlatformError('agent_sandbox_unavailable', 'Your Agent workspace could not be started', { status: 503, retryable: true });

// The controller is a platform service, never a sandbox. It alone can create
// containers. Neither browser credentials nor a Docker socket enter the Agent.
export function createDynamicAgentRoutes({ origin, tokenFile, fetchImplementation = globalThis.fetch }) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || typeof tokenFile !== 'string' || !tokenFile.startsWith('/') || tokenFile.split('/').includes('..')) throw new TypeError('Invalid Agent controller configuration');
  const pending = new Map();
  async function provision(ownerIdentityId) {
    const raw = await readFile(tokenFile);
    let response;
    try {
      const token = raw.toString('utf8').trim();
      if (!/^[A-Za-z0-9_-]{32,4096}$/.test(token)) throw unavailable();
      response = await fetchImplementation(new URL(`/v1/owners/${ownerIdentityId}/ensure`, url), {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(90000),
      });
    } finally { raw.fill(0); }
    if (!response.ok) throw unavailable();
    const value = await response.json();
    const hash = createHash('sha256').update(ownerIdentityId).digest('hex').slice(0,32);
    const expectedOrigin = `http://teamaibox-agent-${hash}:4097`;
    if (value.ownerIdentityId !== ownerIdentityId || value.sandboxKey !== `sandbox.${hash}` || value.origin !== expectedOrigin
      || !/^[A-Za-z0-9_-]{32,4096}$/.test(value.token ?? '')) throw unavailable();
    return Object.freeze({ownerIdentityId, sandboxKey: value.sandboxKey, origin: value.origin,
      client: new OpenCodeBridgeClient({origin: value.origin, tokenProvider: async () => value.token, fetchImplementation, timeoutMs:120000})});
  }
  return Object.freeze({
    async resolve(ownerIdentityId) {
      if (!UUID.test(ownerIdentityId ?? '')) throw unavailable();
      // Deduplicate simultaneous first prompts, but recheck owner status and
      // container health on later prompts, including after controller restart.
      if (!pending.has(ownerIdentityId)) {
        const operation = provision(ownerIdentityId).catch(() => { throw unavailable(); }).finally(() => pending.delete(ownerIdentityId));
        pending.set(ownerIdentityId, operation);
      }
      return pending.get(ownerIdentityId);
    },
  });
}
