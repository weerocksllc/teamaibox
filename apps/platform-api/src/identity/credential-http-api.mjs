import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const DEVELOPER = "/api/v1/developer/credentials";
const DEVELOPER_ITEM = new RegExp(`^${DEVELOPER}/${UUID}$`, "i");
const SERVICE = "/api/v1/admin/service-credentials";
const SERVICE_ITEM = new RegExp(`^${SERVICE}/${UUID}$`, "i");

function scopes(value) {
  return Array.isArray(value) ? value.map((scope) => ({
    permissionKey: scope?.permission_key,
    resourceKind: scope?.resource_kind,
    resourceKey: scope?.resource_key,
  })) : value;
}

function subject(query) {
  const value = query?.get?.("subject_identity_id") ?? null;
  if (typeof value !== "string" || !new RegExp(`^${UUID}$`, "i").test(value)) {
    throw new PlatformError("invalid_service_account", "Service account is invalid", { status: 400 });
  }
  return value;
}

export class CredentialHttpApi {
  #service;

  constructor({ service }) {
    if (!service || ["issueDeveloperCredential", "issueServiceCredential", "listCredentials", "revokeCredential"]
      .some((method) => typeof service[method] !== "function")) throw new TypeError("credential service is incomplete");
    this.#service = service;
  }

  matches(method, pathname) {
    if (pathname === DEVELOPER) return method === "GET" || method === "POST";
    if (pathname === SERVICE) return method === "GET" || method === "POST";
    return method === "DELETE" && (DEVELOPER_ITEM.test(pathname) || SERVICE_ITEM.test(pathname));
  }

  async handle({ method, pathname, context, body = null, query = new URLSearchParams() }) {
    if (method === "GET" && pathname === DEVELOPER) {
      return { kind: "json", status: 200, body: { object: "list", data: await this.#service.listCredentials({ context }) } };
    }
    if (method === "POST" && pathname === DEVELOPER) {
      const value = await this.#service.issueDeveloperCredential({ context, displayName: body?.display_name,
        scopes: scopes(body?.scopes), expiresAt: body?.expires_at });
      return { kind: "json", status: 201, body: value };
    }
    if (method === "GET" && pathname === SERVICE) {
      return { kind: "json", status: 200, body: { object: "list", data: await this.#service.listCredentials({
        context, subjectIdentityId: subject(query),
      }) } };
    }
    if (method === "POST" && pathname === SERVICE) {
      const value = await this.#service.issueServiceCredential({ context,
        serviceIdentityId: body?.service_identity_id, displayName: body?.display_name,
        scopes: scopes(body?.scopes), expiresAt: body?.expires_at });
      return { kind: "json", status: 201, body: value };
    }
    const developer = DEVELOPER_ITEM.exec(pathname);
    const service = SERVICE_ITEM.exec(pathname);
    if (method === "DELETE" && (developer || service)) {
      const value = await this.#service.revokeCredential({ context, credentialId: (developer || service)[1], reason: body?.reason });
      return { kind: "json", status: 200, body: value };
    }
    throw new PlatformError("not_found", "Credential endpoint was not found", { status: 404 });
  }
}
