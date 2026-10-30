import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const KEY = "([a-z][a-z0-9_.-]{2,127})";
const OVERVIEW = /^\/api\/v1\/admin\/storage(?:\/pools)?$/;
const POOLS = /^\/api\/v1\/admin\/storage\/pools$/;
const CLASSES = new RegExp(`^/api/v1/admin/storage/pools/${KEY}/data-classes$`);
const ACTION = new RegExp(`^/api/v1/admin/storage/pools/${KEY}/(drain|complete|remove)$`);

export class StorageAdministrationHttpApi {
  #service;
  constructor({ service }) {
    if (!service || ["overview", "create", "replaceDataClasses", "transition"].some((method) => typeof service[method] !== "function")) throw new TypeError("storage administration service is incomplete");
    this.#service = service;
  }
  matches(method, pathname) {
    return (method === "GET" && OVERVIEW.test(pathname)) || (method === "POST" && POOLS.test(pathname))
      || (method === "PUT" && CLASSES.test(pathname)) || (method === "POST" && ACTION.test(pathname));
  }
  async handle({ method, pathname, context, body = null }) {
    if (method === "GET" && OVERVIEW.test(pathname)) return { kind: "json", status: 200, body: await this.#service.overview({ context }) };
    if (method === "POST" && POOLS.test(pathname)) return { kind: "json", status: 201, body: await this.#service.create({ context, input: {
      poolId: body?.pool_id, displayName: body?.display_name, backendKind: body?.backend_kind, nodeId: body?.node_id,
      failureDomain: body?.failure_domain, totalBytes: body?.total_bytes, availableBytes: body?.available_bytes,
      safetyReserveBytes: body?.safety_reserve_bytes, encryptionMode: body?.encryption_mode,
      dataClasses: body?.data_classes, verificationConfirmation: body?.verification_confirmation,
    } }) };
    const classes = CLASSES.exec(pathname);
    if (method === "PUT" && classes) return { kind: "json", status: 200, body: await this.#service.replaceDataClasses({ context,
      poolId: classes[1], expectedUpdatedAt: body?.expected_updated_at, values: body?.data_classes }) };
    const action = ACTION.exec(pathname);
    if (method === "POST" && action) return { kind: "json", status: 200, body: await this.#service.transition({ context,
      poolId: action[1], action: action[2], expectedUpdatedAt: body?.expected_updated_at, confirmation: body?.confirmation }) };
    throw new PlatformError("not_found", "Storage administration endpoint was not found", { status: 404 });
  }
}
