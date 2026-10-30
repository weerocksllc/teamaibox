import { PlatformError } from "../../../../packages/observability/src/index.mjs";

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function entry(value) {
  return Object.freeze({ id: value.id, object: "files.entry", root_id: value.rootId, parent_id: value.parentId,
    kind: value.kind, name: value.name, revision: value.revision, updated_at: value.updatedAt });
}

export class DelegatedPluginOperationDispatcher {
  #database;
  #files;
  constructor({ database, teamDriveService }) {
    if (!database?.query || !teamDriveService?.rootByScope || !teamDriveService?.list) {
      throw new TypeError("Delegated plugin dispatcher dependencies are incomplete");
    }
    this.#database = database; this.#files = teamDriveService;
  }

  async #teamRole(identityId, teamKey) {
    const row = rows(await this.#database.query(`
      SELECT role.role_key
      FROM iam.role_bindings binding
      JOIN iam.roles role ON role.id = binding.role_id
      JOIN iam.teams team ON team.team_key = binding.scope_key AND team.status = 'active'
      WHERE binding.identity_id = $1 AND binding.scope_kind = 'team' AND binding.scope_key = $2
        AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())`, [identityId, teamKey]))[0];
    if (!row) return null;
    return row.role_key === "team_admin" ? "manager" : row.role_key;
  }

  async invoke({ delegated, operation, body, idempotencyKey = null }) {
    if (operation !== "files.list" || delegated?.permission !== "file:read" || delegated?.resource?.kind !== "team") {
      throw new PlatformError("plugin_operation_denied", "Delegated plugin operation is not available", { status: 403 });
    }
    if (!body || Object.keys(body).some((key) => !new Set(["path", "pageSize"]).has(key))
      || body.path !== "/notes" || !Number.isSafeInteger(body.pageSize) || body.pageSize < 1 || body.pageSize > 100
      || (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128))) {
      throw new PlatformError("plugin_operation_invalid", "Delegated plugin operation payload is invalid", { status: 400 });
    }
    const teamKey = delegated.resource.key;
    const role = await this.#teamRole(delegated.identityId, teamKey);
    if (!role) throw new PlatformError("plugin_delegation_scope_revoked", "Delegated team authority has been revoked", { status: 403 });
    const context = Object.freeze({ actorIdentityId: delegated.identityId, permissions: Object.freeze(["file:read"]),
      teamRoles: Object.freeze({ [teamKey]: role }) });
    const root = await this.#files.rootByScope(context, "team", teamKey);
    const data = root ? (await this.#files.list(context, root.id, { parentId: null, includeTrashed: false }))
      .slice(0, body.pageSize).map(entry) : [];
    return Object.freeze({ object: "list", data: Object.freeze(data), path: body.path });
  }
}
