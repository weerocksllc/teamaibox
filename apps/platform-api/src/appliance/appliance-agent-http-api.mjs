import { PlatformError } from '../../../../packages/observability/src/index.mjs';

// Only the already-installed local agent reports health. There is no remote
// enrollment, node selection, certificate claim, group or deployment API.
export class ApplianceAgentHttpApi {
  constructor({ service, metricService, localNodeId }) {
    if (!localNodeId || !service?.heartbeat) throw new TypeError('Local appliance identity is required');
    this.service = service; this.metrics = metricService; this.nodeId = localNodeId.toLowerCase();
  }
  routeKind(method, pathname) { return this.matches(method, pathname) ? 'managed-node' : null; }
  matches(method, pathname) {
    return method === 'POST' && ['/api/v1/appliance/heartbeat', '/api/v1/appliance/metrics'].includes(pathname);
  }
  async handle({ method, pathname, body, transportIdentity }) {
    if (!this.matches(method, pathname)) throw new PlatformError('not_found', 'Endpoint not found', { status: 404 });
    if (transportIdentity?.mutualTls !== true || transportIdentity?.certificateVerified !== true
        || transportIdentity?.subjectNodeId !== this.nodeId || (body?.nodeId && body.nodeId !== this.nodeId)) {
      throw new PlatformError('appliance_identity_mismatch', 'Only this appliance is accepted', { status: 403 });
    }
    if (pathname.endsWith('/heartbeat')) return { kind: 'json', status: 200,
      body: await this.service.heartbeat({ transportIdentity, nodeId: this.nodeId, generation: body?.generation, inventory: body?.inventory }) };
    if (!this.metrics) throw new PlatformError('appliance_metrics_unavailable', 'Device metrics unavailable', { status: 503 });
    return { kind: 'json', status: 202, body: await this.metrics.ingest({ transportIdentity,
      nodeId: this.nodeId, nodeGeneration: body?.generation, snapshot: body?.snapshot }) };
  }
}
