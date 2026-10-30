import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const CAPABILITIES = new Set([
  "image", "ocr", "asr", "translation", "team_drive",
  "messaging.attachment", "assistant.input", "assistant.artifact",
  "virtual_phone", "virtual_computer",
]);
const CAPABILITY_AUDIENCE = Object.freeze({
  team_drive: "team-drive.file",
  virtual_phone: "virtual-phone.file",
  virtual_computer: "virtual-computer.iso",
  "messaging.attachment": "messaging.attachment",
  "assistant.input": "assistant.input",
  "assistant.artifact": "assistant.artifact",
});
const UPLOAD_PATH = "/api/v1/objects/uploads";
const MULTIPART_PATH = "/api/v1/objects/multipart";

function fail(code, message, status = 400) {
  throw new PlatformError(code, message, { status });
}

function referencePath(pathname) {
  const match = /^\/api\/v1\/objects\/([0-9a-f-]{36})\/references$/i.exec(pathname);
  return match && UUID.test(match[1]) ? match[1] : null;
}

function contentPath(pathname) {
  const match = /^\/api\/v1\/objects\/references\/([0-9a-f-]{36})\/content$/i.exec(pathname);
  return match && UUID.test(match[1]) ? match[1] : null;
}

function issuedReferencePath(pathname) {
  const match = /^\/api\/v1\/objects\/references\/([0-9a-f-]{36})$/i.exec(pathname);
  return match && UUID.test(match[1]) ? match[1] : null;
}

function multipartPath(pathname) {
  const match = /^\/api\/v1\/objects\/multipart\/([0-9a-f-]{36})(?:\/parts(?:\/(\d+))?)?$/i.exec(pathname);
  if (!match || !UUID.test(match[1])) return null;
  return {
    uploadId: match[1],
    partNumber: match[2] === undefined ? null : Number(match[2]),
    partsPath: pathname.includes("/parts"),
  };
}

function fileName(headers) {
  const value = headers["x-teamaibox-object-name"];
  if (Array.isArray(value) || typeof value !== "string" || value.length > 3072) {
    fail("invalid_object_name", "Object name is required");
  }
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { fail("invalid_object_name", "Object name is invalid"); }
  const name = decoded.normalize("NFC").split(/[\\/]/).at(-1).trim();
  if (!name || name.length > 240 || /[\u0000-\u001f\u007f]/u.test(name)) {
    fail("invalid_object_name", "Object name is invalid");
  }
  return name;
}

function downloadDisposition(metadata) {
  // The object key is scoped storage metadata, not a user-facing random ID.
  // Only its filename is sent; never expose the namespace or storage path.
  const leaf = String(metadata.objectKey ?? "").split(/[\\/]/).at(-1).normalize("NFC").toWellFormed()
    .replace(/[\u0000-\u001f\u007f]/gu, "_").trim();
  const name = leaf && leaf !== "." && leaf !== ".." ? leaf : `object-${metadata.objectId}`;
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function capability(value) {
  if (typeof value !== "string" || !CAPABILITIES.has(value)) {
    fail("invalid_object_audience", "Object capability audience is invalid");
  }
  return value;
}

function objectContext(context, operation) {
  if (!context?.identityId || context.identity?.identityKind !== "local_user") {
    fail("object_access_denied", "Object access denied", 403);
  }
  const permission = operation === "write" ? "file:write" : "file:read";
  if (!context.permissions?.includes(permission)) fail("object_access_denied", "Object access denied", 403);
  const namespaceKey = `user:${context.identityId}`;
  return {
    namespaceKey,
    serviceContext: {
      identityId: context.identityId,
      identityKind: "local_user",
      permissions: context.permissions,
      namespaceAccess: [{
        namespaceKey,
        operations: ["read", "write", "list", "delete", "reference:create", "reference:revoke"],
      }],
    },
  };
}

function boundedLimit(value) {
  if (value === null) return 50;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) fail("invalid_page", "Object list limit is invalid");
  return parsed;
}

function boundedReferenceLifetime(value) {
  if (value === null || value === undefined) return 600;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 600) {
    fail("invalid_object_expiry", "Object reference lifetime must be between 1 and 600 seconds");
  }
  return parsed;
}

function byteRange(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) fail("invalid_range", "Object range is invalid", 416);
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) fail("invalid_range", "Object range is invalid", 416);
  return {
    start: Number(match[1]),
    ...(match[2] ? { endInclusive: Number(match[2]) } : {}),
  };
}

export class ObjectHttpApi {
  #service;
  #authorizeReference;

  constructor({ service, authorizeReference = async () => {} }) {
    const required = [
      "upload", "list", "beginMultipart", "uploadPart", "listUploadParts", "completeMultipart",
      "abortMultipart", "createScopedReference", "revokeScopedReference", "downloadByReferenceId", "headByReferenceId",
    ];
    if (!service || required.some((method) => typeof service[method] !== "function")) {
      throw new TypeError("protected object service is incomplete");
    }
    this.#service = service;
    if (typeof authorizeReference !== "function") throw new TypeError("Reference authorization is invalid");
    this.#authorizeReference = authorizeReference;
  }

  matches(method, pathname) {
    const multipart = multipartPath(pathname);
    return (method === "POST" && pathname === UPLOAD_PATH)
      || (method === "POST" && pathname === MULTIPART_PATH)
      || (multipart !== null && (
        (method === "PUT" && multipart.partsPath && multipart.partNumber !== null)
        || (method === "GET" && multipart.partsPath && multipart.partNumber === null)
        || (new Set(["POST", "DELETE"]).has(method) && !multipart.partsPath)
      ))
      || (method === "GET" && pathname === "/api/v1/objects")
      || (method === "POST" && referencePath(pathname) !== null)
      || (method === "DELETE" && issuedReferencePath(pathname) !== null)
      || (new Set(["GET", "HEAD"]).has(method) && contentPath(pathname) !== null);
  }

  bodyKind(method, pathname) {
    const multipart = multipartPath(pathname);
    if ((method === "POST" && pathname === UPLOAD_PATH)
      || (method === "PUT" && multipart?.partsPath && multipart.partNumber !== null)) return "bytes";
    if (method === "POST" && (pathname === MULTIPART_PATH || multipart || referencePath(pathname))) return "json";
    return "none";
  }

  async #reference({ serviceContext, namespaceKey, objectId, selectedCapability, expiresInSeconds = 600 }) {
    const created = await this.#service.createScopedReference({
      context: serviceContext,
      namespaceKey,
      objectId,
      audience: CAPABILITY_AUDIENCE[selectedCapability] ?? `compute:${selectedCapability}`,
      operations: ["head", "read", "range"],
      expiresAt: new Date(Date.now() + boundedReferenceLifetime(expiresInSeconds) * 1000),
    });
    return created.reference;
  }

  async handle({ method, pathname, body = null, context, headers = {}, query = new URLSearchParams() }) {
    if (method === "POST" && pathname === MULTIPART_PATH) {
      const { namespaceKey, serviceContext } = objectContext(context, "write");
      const selectedCapability = capability(body?.capability);
      const name = fileName({ "x-teamaibox-object-name": encodeURIComponent(body?.name ?? "") });
      const upload = await this.#service.beginMultipart({
        context: serviceContext,
        namespaceKey,
        objectKey: `${selectedCapability==='virtual_computer'?'virtual-computers/installation':selectedCapability==='virtual_phone'?'virtual-phones/inputs':selectedCapability==='team_drive'?'team-drive':`ai-inputs/${selectedCapability}`}/${randomUUID()}/${name}`,
        contentType: body?.media_type,
        expectedSize: body?.size,
        expectedSha256: body?.sha256,
      });
      return { kind: "json", status: 201, body: { upload, part_size_bytes: 16 * 1024 * 1024 } };
    }

    const multipart = multipartPath(pathname);
    if (multipart && method === "PUT" && multipart.partsPath && multipart.partNumber !== null) {
      const { serviceContext } = objectContext(context, "write");
      const expectedSha256 = headers["x-content-sha256"];
      if (Array.isArray(expectedSha256) || typeof expectedSha256 !== "string" || !DIGEST.test(expectedSha256)) {
        fail("invalid_integrity", "A lowercase SHA-256 digest is required");
      }
      const part = await this.#service.uploadPart({
        context: serviceContext,
        uploadId: multipart.uploadId,
        partNumber: multipart.partNumber,
        content: body,
        expectedSha256,
      });
      return { kind: "json", status: 200, body: { part } };
    }

    if (multipart && method === "GET" && multipart.partsPath && multipart.partNumber === null) {
      const { serviceContext } = objectContext(context, "write");
      const parts = await this.#service.listUploadParts({ context: serviceContext, uploadId: multipart.uploadId });
      return { kind: "json", status: 200, body: { object: "list", data: parts } };
    }

    if (multipart && method === "POST" && !multipart.partsPath) {
      const { namespaceKey, serviceContext } = objectContext(context, "write");
      const parts = Array.isArray(body?.parts)
        ? body.parts.map((part) => ({ partNumber: part?.part_number, sha256: part?.sha256 }))
        : body?.parts;
      const object = await this.#service.completeMultipart({
        context: serviceContext, uploadId: multipart.uploadId, parts,
      });
      const reference = await this.#reference({
        serviceContext, namespaceKey, objectId: object.objectId,
        selectedCapability: object.objectKey?.startsWith('virtual-computers/installation/') ? 'virtual_computer'
          :object.objectKey?.startsWith('virtual-phones/') ? 'virtual_phone'
          :object.objectKey?.startsWith('ai-inputs/')?capability(object.objectKey.split('/')[1]):'team_drive',
      });
      return {
        kind: "json",
        status: 201,
        body: { object, reference_id: reference.referenceId, reference_expires_at: reference.expiresAt },
      };
    }

    if (multipart && method === "DELETE" && !multipart.partsPath) {
      const { serviceContext } = objectContext(context, "write");
      const aborted = await this.#service.abortMultipart({ context: serviceContext, uploadId: multipart.uploadId });
      return { kind: "json", status: 200, body: { upload_id: aborted.uploadId, aborted: aborted.aborted } };
    }

    if (method === "POST" && pathname === UPLOAD_PATH) {
      const { namespaceKey, serviceContext } = objectContext(context, "write");
      if (!(body instanceof Uint8Array) || body.byteLength < 1) fail("invalid_object_content", "Object content is required");
      const name = fileName(headers);
      const expectedSha256 = headers["x-content-sha256"];
      if (Array.isArray(expectedSha256) || typeof expectedSha256 !== "string" || !DIGEST.test(expectedSha256)) {
        fail("invalid_integrity", "A lowercase SHA-256 digest is required");
      }
      const selectedCapability = capability(query.get("capability"));
      const uploaded = await this.#service.upload({
        context: serviceContext,
        namespaceKey,
        objectKey: `ai-inputs/${randomUUID()}/${name}`,
        contentType: headers["content-type"] || "application/octet-stream",
        content: body,
        expectedSha256,
      });
      const reference = await this.#reference({
        serviceContext, namespaceKey, objectId: uploaded.objectId, selectedCapability,
      });
      return {
        kind: "json",
        status: 201,
        body: { object: uploaded, reference_id: reference.referenceId, reference_expires_at: reference.expiresAt },
      };
    }

    if (method === "GET" && pathname === "/api/v1/objects") {
      const { namespaceKey, serviceContext } = objectContext(context, "read");
      const page = await this.#service.list({
        context: serviceContext,
        namespaceKey,
        prefix: query.get("prefix") ?? "",
        cursor: query.get("after"),
        limit: boundedLimit(query.get("limit")),
      });
      return { kind: "json", status: 200, body: { object: "list", data: page.items, next_after: page.nextCursor } };
    }

    const objectId = referencePath(pathname);
    if (method === "POST" && objectId) {
      const { namespaceKey, serviceContext } = objectContext(context, "read");
      const selectedCapability = capability(body?.capability);
      const reference = await this.#reference({
        serviceContext,
        namespaceKey,
        objectId,
        selectedCapability,
        expiresInSeconds: boundedReferenceLifetime(body?.expires_in_seconds),
      });
      return {
        kind: "json", status: 201,
        body: { reference_id: reference.referenceId, reference_expires_at: reference.expiresAt },
      };
    }

    const referenceId = contentPath(pathname);
    if (referenceId && new Set(["GET", "HEAD"]).has(method)) {
      const { serviceContext } = objectContext(context, "read");
      await this.#authorizeReference({ context, referenceId });
      if (method === "HEAD") {
        const metadata = await this.#service.headByReferenceId({ context: serviceContext, referenceId });
        return { kind: "empty", status: 200, headers: {
          "accept-ranges": "bytes", "content-length": String(metadata.size), "content-type": metadata.contentType,
          etag: `\"sha256:${metadata.integrity.digest}\"`,
          ...(query.get("download") === "1" ? { "content-disposition": downloadDisposition(metadata) } : {}),
        } };
      }
      const download = await this.#service.downloadByReferenceId({
        context: serviceContext, referenceId, range: byteRange(headers.range),
      });
      const responseHeaders = {
        "accept-ranges": "bytes",
        "content-length": String(download.content.byteLength),
        "content-type": download.metadata.contentType,
        etag: `\"sha256:${download.metadata.integrity.digest}\"`,
      };
      if (download.partial) responseHeaders["content-range"] = `bytes ${download.range.start}-${download.range.endInclusive}/${download.range.total}`;
      if (query.get("download") === "1") responseHeaders["content-disposition"] = downloadDisposition(download.metadata);
      return { kind: "bytes", status: download.partial ? 206 : 200, body: download.content, headers: responseHeaders };
    }

    const revokedReferenceId = issuedReferencePath(pathname);
    if (method === "DELETE" && revokedReferenceId) {
      const { serviceContext } = objectContext(context, "read");
      const revoked = await this.#service.revokeScopedReference({
        context: serviceContext,
        referenceId: revokedReferenceId,
        reason: "issuer_revoked",
      });
      return { kind: "json", status: 200, body: revoked };
    }
    fail("not_found", "Endpoint was not found", 404);
  }
}
