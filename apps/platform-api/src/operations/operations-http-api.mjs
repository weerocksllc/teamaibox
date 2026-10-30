import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const DASHBOARD = /^\/api\/v1\/admin\/appliance$/;
const HEALTH = /^\/api\/v1\/admin\/operations\/health$/;
const ALERTS = /^\/api\/v1\/admin\/operations\/alerts$/;
const CORRELATION = /^\/api\/v1\/admin\/operations\/correlations\/([A-Za-z0-9%][A-Za-z0-9._:%-]{7,383})$/;
const EXPORT = /^\/api\/v1\/admin\/operations\/diagnostic-exports$/;
const RETENTION = /^\/api\/v1\/admin\/operations\/retention\/run$/;

export function matchesOperationsHttpRoute(method, pathname) {
  return (method === "GET" && (DASHBOARD.test(pathname) || HEALTH.test(pathname) || ALERTS.test(pathname) || CORRELATION.test(pathname)))
    || (method === "POST" && (EXPORT.test(pathname) || RETENTION.test(pathname)));
}

export class OperationsHttpApi {
  #service; #diagnostics;
  constructor({ service = null, diagnostics = null }) {
    if (service !== null && (!service?.getDashboard || !service?.getNode)) throw new TypeError("Operations dashboard service is incomplete");
    if (diagnostics !== null && (!diagnostics?.getHealth || !diagnostics?.getAlerts || !diagnostics?.getCorrelation || !diagnostics?.exportDiagnostics || !diagnostics?.runRetention)) throw new TypeError("Operational diagnostics service is incomplete");
    if (service === null && diagnostics === null) throw new TypeError("At least one operations service is required");
    this.#service = service; this.#diagnostics = diagnostics;
  }
  matches(method, pathname) { return matchesOperationsHttpRoute(method, pathname); }
  async handle({ method, pathname, context, body = null, query = null, signal }) {
    const page = () => ({ ...(query?.get?.("limit") == null ? {} : { limit: Number(query.get("limit")) }), cursor: query?.get?.("cursor") ?? null });
    if (method === "GET" && DASHBOARD.test(pathname) && this.#service) return { kind: "json", status: 200, body: await this.#service.getDashboard({ context }) };
    if (method === "GET" && HEALTH.test(pathname) && this.#diagnostics) return { kind: "json", status: 200, body: await this.#diagnostics.getHealth({ context }) };
    if (method === "GET" && ALERTS.test(pathname) && this.#diagnostics) return { kind: "json", status: 200, body: await this.#diagnostics.getAlerts({ context, status: query?.get?.("status") ?? "open", ...page() }) };
    const correlation = CORRELATION.exec(pathname);
    if (method === "GET" && correlation && this.#diagnostics) {
      let correlationId; try { correlationId = decodeURIComponent(correlation[1]); } catch { throw new PlatformError("correlation_id_invalid", "Correlation identifier is invalid", { status: 400 }); }
      return { kind: "json", status: 200, body: await this.#diagnostics.getCorrelation({ context, correlationId, ...page() }) };
    }
    if (method === "POST" && EXPORT.test(pathname) && this.#diagnostics) {
      if (this.#diagnostics.streamDiagnostics) {
        const result = await this.#diagnostics.streamDiagnostics({ context, request: body ?? {}, signal });
        return { kind: "stream", status: 201, body: result.body, headers: {
          "content-type": "application/json; charset=utf-8", "x-accel-buffering": "no",
          "content-disposition": `attachment; filename="teamaibox-diagnostics-${result.exportId}.json"`,
        } };
      }
      return { kind: "json", status: 201, body: await this.#diagnostics.exportDiagnostics({ context, request: body ?? {} }) };
    }
    if (method === "POST" && RETENTION.test(pathname) && this.#diagnostics) return { kind: "json", status: 200, body: await this.#diagnostics.runRetention({ context }) };
    throw new PlatformError("not_found", "Operations endpoint was not found", { status: 404 });
  }
}
