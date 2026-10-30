#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const target = process.argv[2];
if (typeof target !== "string" || !target.startsWith("/")) {
  throw new TypeError("an absolute Platform API server path is required");
}

let source = await readFile(target, "utf8");
if (source.includes("CastingHttpApi") || source.includes("PLATFORM_CASTING_AVAILABILITY_FILE")) {
  throw new Error("Platform parent already contains a casting overlay");
}

function replaceExactlyOnce(anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`Platform parent ${label} anchor is missing or ambiguous`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

replaceExactlyOnce(
  'import { MessagingHttpApi } from "../src/messaging/messaging-http-api.mjs";\n',
  'import { MessagingHttpApi } from "../src/messaging/messaging-http-api.mjs";\n'
    + 'import { CastingHttpApi } from "../src/casting/casting-http-api.mjs";\n',
  "HTTP API import",
);
replaceExactlyOnce(
  'import { PostgresMessagingRepository } from "../../../services/messaging/src/postgres-repository.mjs";\n',
  'import { PostgresMessagingRepository } from "../../../services/messaging/src/postgres-repository.mjs";\n'
    + 'import { FileDisabledCastingAvailability } from "../src/casting/file-disabled-casting-availability.mjs";\n',
  "availability import",
);
replaceExactlyOnce(
  "  messagingApi = null,\n  nodeTransportIdentityResolver = managedNodeTransportIdentity,",
  "  messagingApi = null,\n  castingApi = null,\n  nodeTransportIdentityResolver = managedNodeTransportIdentity,",
  "server parameter",
);
replaceExactlyOnce(
  '  if (messagingApi !== null && (typeof messagingApi.matches !== "function" || typeof messagingApi.handle !== "function")) {\n'
    + '    throw new TypeError("messaging API is invalid");\n'
    + '  }\n',
  '  if (messagingApi !== null && (typeof messagingApi.matches !== "function" || typeof messagingApi.handle !== "function")) {\n'
    + '    throw new TypeError("messaging API is invalid");\n'
    + '  }\n'
    + '  if (castingApi !== null && (typeof castingApi.matches !== "function" || typeof castingApi.handle !== "function")) {\n'
    + '    throw new TypeError("casting API is invalid");\n'
    + '  }\n',
  "server validation",
);
replaceExactlyOnce(
  "        if (userActivityApi?.matches(request.method, pathname)) {",
  "        if (castingApi?.matches(request.method, pathname)) {\n"
    + "          const stateChanging = request.method !== \"GET\";\n"
    + "          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });\n"
    + "          const body = stateChanging ? await jsonBody(request, MAX_COMPUTE_BODY_BYTES) : null;\n"
    + "          const result = await castingApi.handle({\n"
    + "            method: request.method, pathname, body, context, headers: request.headers,\n"
    + "            query: requestQuery(request), requestId, signal: disconnect.signal,\n"
    + "          });\n"
    + "          jsonResponse(response, requestId, result.status, result.body, result.headers);\n"
    + "          return;\n"
    + "        }\n"
    + "        if (userActivityApi?.matches(request.method, pathname)) {",
  "HTTP route",
);
replaceExactlyOnce(
  "  const server = createPlatformApiServer({\n",
  "  const castingAvailability = environment.PLATFORM_CASTING_AVAILABILITY_FILE\n"
    + "    ? await FileDisabledCastingAvailability.fromFile(environment.PLATFORM_CASTING_AVAILABILITY_FILE)\n"
    + "    : null;\n"
    + "  const server = createPlatformApiServer({\n",
  "startup",
);
replaceExactlyOnce(
  "    messagingApi: new MessagingHttpApi({ service: messagingService }),\n"
    + "    nodeTransportIdentityResolver:",
  "    messagingApi: new MessagingHttpApi({ service: messagingService }),\n"
    + "    castingApi: castingAvailability ? new CastingHttpApi({ availability: castingAvailability }) : null,\n"
    + "    nodeTransportIdentityResolver:",
  "server wiring",
);

for (const required of [
  "CastingHttpApi",
  "FileDisabledCastingAvailability.fromFile",
  "PLATFORM_CASTING_AVAILABILITY_FILE",
  "castingApi?.matches",
]) {
  if (!source.includes(required)) throw new Error(`disabled casting overlay is incomplete: ${required}`);
}

await writeFile(target, source, "utf8");
