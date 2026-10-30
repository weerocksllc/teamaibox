import { timingSafeEqual, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { PlatformError } from '../../../packages/observability/src/index.mjs';
import { signManagedNodeGatewayIdentity } from '../../../packages/authorization/src/managed-node-gateway-identity.mjs';
import { ManagedNodeService } from '../../../services/scheduler/src/managed-node-service.mjs';
import { ManagedNodeAgentRouter } from '../../../services/scheduler/src/managed-node-agent-router.mjs';
import { PostgresManagedNodeRepository } from '../../../services/scheduler/src/postgres-managed-node-repository.mjs';
import { ProtectedNodeAgentClient } from '../../../services/scheduler/src/protected-node-agent-client.mjs';
import { NodeAgentHttpsTransport } from '../../../services/scheduler/src/node-agent-https-transport.mjs';
import { HmacNodeAgentCommandSigner } from '../../../services/scheduler/src/node-agent-command-signer.mjs';
import { NodeAgentWorkerSpecFactory } from '../../../services/scheduler/src/node-agent-worker-spec-factory.mjs';
import { createApplianceProtectedOfficeRuntime } from './appliance-protected-office-runtime.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{22,86}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
function header(request, name) {
  const value = request?.headers?.[name];
  return typeof value === "string" ? value : null;
}

export function signGatewayNodeIdentity({ key, method, pathname, timestamp, nonce, subjectNodeId, certificateFingerprint }) {
  return signManagedNodeGatewayIdentity({ key, method, pathname, timestamp, nonce, subjectNodeId, certificateFingerprint });
}

export class SignedGatewayNodeTransportIdentityResolver {
  #key; #clock; #maximumAgeMs; #nonces = new Map();
  constructor({ key, clock = () => new Date(), maximumAgeMs = 30_000 }) {
    if (!Buffer.isBuffer(key) || key.byteLength < 32 || typeof clock !== "function" || !Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 5_000 || maximumAgeMs > 60_000) {
      throw new TypeError("managed node gateway verifier configuration is invalid");
    }
    this.#key = Buffer.from(key); this.#clock = clock; this.#maximumAgeMs = maximumAgeMs;
  }
  resolve(request) {
    const timestamp = header(request, "x-teamaibox-node-timestamp");
    const nonce = header(request, "x-teamaibox-node-nonce");
    const subjectNodeId = header(request, "x-teamaibox-node-id")?.toLowerCase();
    const certificateFingerprint = header(request, "x-teamaibox-node-certificate-fingerprint");
    const signature = header(request, "x-teamaibox-node-signature");
    const pathname = (() => { try { return new URL(request?.url ?? "", "http://platform.invalid").pathname; } catch { return ""; } })();
    const observedAt = Date.parse(timestamp ?? ""), now = this.#clock().getTime();
    for (const [value, expiresAt] of this.#nonces) if (expiresAt <= now) this.#nonces.delete(value);
    if (!UUID.test(subjectNodeId ?? "") || !SHA256.test(certificateFingerprint ?? "") || !NONCE.test(nonce ?? "") || !SIGNATURE.test(signature ?? "")
        || !Number.isFinite(observedAt) || Math.abs(now - observedAt) > this.#maximumAgeMs || this.#nonces.has(nonce)) {
      throw new PlatformError("managed_node_mtls_required", "Verified mutual TLS node identity is required", { status: 401 });
    }
    const expected = signGatewayNodeIdentity({ key: this.#key, method: request.method, pathname, timestamp, nonce, subjectNodeId, certificateFingerprint });
    const supplied = Buffer.from(signature, "base64url"), calculated = Buffer.from(expected, "base64url");
    if (supplied.byteLength !== calculated.byteLength || !timingSafeEqual(supplied, calculated)) {
      throw new PlatformError("managed_node_mtls_required", "Verified mutual TLS node identity is required", { status: 401 });
    }
    this.#nonces.set(nonce, now + this.#maximumAgeMs);
    return Object.freeze({ mutualTls: true, certificateVerified: true, subjectNodeId, certificateFingerprint });
  }
  close() { this.#key.fill(0); this.#nonces.clear(); }
}


export function applianceRuntimeConfigured(environment = process.env) {
  return Boolean(environment.PLATFORM_APPLIANCE_NODE_ID && environment.PLATFORM_API_PERSISTENCE === 'postgres')
    || Object.keys(environment).some(key => key.startsWith('PLATFORM_APPLIANCE_') && key.endsWith('_FILE') && environment[key]);
}
export function applianceConfiguration(environment) {
  const nodeId = environment.PLATFORM_APPLIANCE_NODE_ID;
  if (!UUID.test(nodeId ?? '')) throw new TypeError('PLATFORM_APPLIANCE_NODE_ID must identify this appliance');
  // API and execution agent are installed on the same host. No endpoint catalog.
  const host = environment.PLATFORM_APPLIANCE_AGENT_HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new TypeError('Appliance agent must use the local loopback interface');
  const port = Number(environment.PLATFORM_APPLIANCE_AGENT_PORT || 9443);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid appliance agent port');
  return Object.freeze({ nodeId: nodeId.toLowerCase(), host, port });
}
async function bytes(environment, key, encoding = null) {
  const path = environment[key];
  if (!isAbsolute(path ?? '')) throw new TypeError(key + ' must be an absolute file path');
  const raw = await readFile(path);
  if (!raw.length || raw.length > 1048576) { raw.fill(0); throw new TypeError(key + ' is invalid'); }
  if (!encoding) return raw;
  try {
    const text = raw.toString('utf8').trim();
    const keyBytes = Buffer.from(text, encoding);
    if (keyBytes.length < 32 || keyBytes.length > 128 || keyBytes.toString(encoding) !== text) {
      keyBytes.fill(0); throw new TypeError(key + ' is invalid');
    }
    return keyBytes;
  } finally { raw.fill(0); }
}
export async function createApplianceRuntimeFromEnvironment(environment, { database, audit, healthSink = null } = {}) {
  const config = applianceConfiguration(environment);
  if (!database?.query || !database?.transaction || typeof audit !== 'function') throw new TypeError('Appliance runtime requires persistence and audit');
  const secrets = [];
  let verifier = null;
  const read = async (key, encoding) => { const value = await bytes(environment, key, encoding); secrets.push(value); return value; };
  try {
    const gatewayKey = await read('PLATFORM_APPLIANCE_GATEWAY_SIGNING_KEY_FILE', 'base64url');
    const ca = await read('PLATFORM_APPLIANCE_CA_FILE');
    const certificate = await read('PLATFORM_APPLIANCE_CERT_FILE');
    const privateKey = await read('PLATFORM_APPLIANCE_KEY_FILE');
    const commandKey = await read('PLATFORM_APPLIANCE_COMMAND_KEY_FILE', 'base64');
    verifier = new SignedGatewayNodeTransportIdentityResolver({ key: gatewayKey });
    const repository = new PostgresManagedNodeRepository({ database, localNodeId: config.nodeId });
    const agentCertificate = new X509Certificate(await read('PLATFORM_APPLIANCE_AGENT_CERT_FILE'));
    const nodeKey = environment.PLATFORM_APPLIANCE_NODE_KEY || 'localhost';
    const expectedUri = `URI:spiffe://teamaibox.local/node/${config.nodeId}`;
    if (!agentCertificate.subjectAltName?.split(/,\s*/).includes(expectedUri)
        || !agentCertificate.checkHost(nodeKey)
        || Date.parse(agentCertificate.validTo) <= Date.now()) {
      throw new TypeError('Installed agent certificate does not identify this appliance');
    }
    await repository.ensureLocalAppliance({ nodeKey,
      certificateFingerprint: 'sha256:' + agentCertificate.fingerprint256.replaceAll(':', '').toLowerCase(),
      certificateNotAfter: new Date(agentCertificate.validTo),
      agentVersion: environment.PLATFORM_APPLIANCE_AGENT_VERSION || '0.1.0' });
    const service = new ManagedNodeService({ repository, localNodeId: config.nodeId, audit, healthSink,
      staleAfterMilliseconds: Number(environment.PLATFORM_APPLIANCE_STALE_AFTER_MS || 45000) });
    await service.beginObservationWindow();
    const nodeAgentRouter = new ManagedNodeAgentRouter({ nodeRepository: repository, localNodeId: config.nodeId,
      connectorFactory: async route => new ProtectedNodeAgentClient({ nodeId: config.nodeId,
        nodeGeneration: route.nodeGeneration, allowRetainedRuntime: route.allowRetainedRuntime === true,
        transport: new NodeAgentHttpsTransport({ host: config.host, port: config.port,
          expectedServerName: route.expectedServerName,
          expectedCertificateFingerprint: route.expectedCertificateFingerprint, ca, certificate, privateKey }),
        commandSigner: new HmacNodeAgentCommandSigner({ keyId: environment.PLATFORM_APPLIANCE_COMMAND_KEY_ID || 'scheduler-persistent-v1', key: commandKey }),
        workerSpecFactory: new NodeAgentWorkerSpecFactory() }) });
    const protectedOfficeCatalogRuntime = createApplianceProtectedOfficeRuntime(environment, { nodeRepository: repository, nodeAgentRouter });
    return Object.freeze({ service, repository, nodeAgentRouter, protectedOfficeCatalogRuntime,
      nodeTransportIdentityResolver(request) {
        const identity = verifier.resolve(request);
        if (identity.subjectNodeId !== config.nodeId) throw new PlatformError('appliance_identity_mismatch', 'Only this appliance is accepted', { status: 403 });
        return identity;
      },
      close() { verifier.close(); for (const value of secrets) value.fill(0); } });
  } catch(error) { verifier?.close(); for (const value of secrets) value.fill(0); throw error; }
}
