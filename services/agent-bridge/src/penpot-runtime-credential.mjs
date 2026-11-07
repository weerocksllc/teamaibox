import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Separate from the Agent bridge bearer: this value cannot authenticate to the
// bridge. Only trusted runtime setup/dispatch reads the existing secret file.
export function penpotRuntimeCredential(identityId, bridgeToken) {
  if (!UUID.test(identityId ?? '') || !/^[A-Za-z0-9_-]{32,4096}$/.test(bridgeToken ?? '')) {
    throw new TypeError('Owned runtime credentials are required');
  }
  return 'tabdr1_' + identityId + '_' + createHmac('sha256', bridgeToken)
    .update('teamaibox-penpot-runtime-v1\0').update(identityId).digest('base64url');
}

export function penpotCredentialOwner(value) {
  if (typeof value !== 'string') return null;
  const match = /^tabdr1_([a-f0-9-]{36})_([A-Za-z0-9_-]{43})$/.exec(value);
  return match && UUID.test(match[1]) ? match[1] : null;
}

export function penpotRuntimeAuthentication(identityId, bridgeToken) {
  const expected = penpotRuntimeCredential(identityId, bridgeToken);
  return Object.freeze({
    // Credential generation, not a claim about a container's boot identifier.
    runtimeId: createHash('sha256').update(expected).digest('hex'),
    // Internal socket/config adapter only; never serialize this to a browser.
    credential: () => expected,
    accepts(value) {
      if (penpotCredentialOwner(value) !== identityId) return false;
      const actual = Buffer.from(value), known = Buffer.from(expected);
      return actual.length === known.length && timingSafeEqual(actual, known);
    },
  });
}
