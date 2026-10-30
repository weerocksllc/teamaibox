// Browser-only visual fixture. Production code never imports this file.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationPluginSharedAsset } from "../../../packages/application-plugin-runtime/src/static-server.mjs";

const SELF = "018f6f18-24d7-7c21-9b62-8c0174199501";
const MEI = "018f6f18-24d7-7c21-9b62-8c0174199502";
const BOT = "018f6f18-24d7-7c21-9b62-8c0174199504";
const DIRECT = "018f6f18-24d7-7c21-9b62-8c0174199511";
const GROUP = "018f6f18-24d7-7c21-9b62-8c0174199512";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src/public");
const now = new Date().toISOString();
const conversations = [
  { id: DIRECT, kind: "direct", title: null, participants: [{ identity_id: SELF, role: "owner", last_read_sequence: 3 }, { identity_id: MEI, role: "member", last_read_sequence: 3 }], last_message_sequence: 3, revision: 2, created_at: now, updated_at: now },
  { id: GROUP, kind: "group", title: "产品发布小组", participants: [{ identity_id: SELF, role: "owner", last_read_sequence: 1 }, { identity_id: MEI, role: "member", last_read_sequence: 0 }, { identity_id: BOT, role: "member", last_read_sequence: 1 }], last_message_sequence: 2, revision: 1, created_at: now, updated_at: new Date(Date.now() - 5400000).toISOString() },
];
const messages = new Map([
  [DIRECT, [
    { id: "018f6f18-24d7-7c21-9b62-8c0174199521", conversation_id: DIRECT, sequence: 1, author_identity_id: MEI, author_kind: "user", content: "发布前的检查清单我已经整理好了。", attachments: [], created_at: new Date(Date.now() - 7200000).toISOString() },
    { id: "018f6f18-24d7-7c21-9b62-8c0174199522", conversation_id: DIRECT, sequence: 2, author_identity_id: SELF, author_kind: "user", content: "收到，我先让 AI 助手检查风险项。", attachments: [], created_at: new Date(Date.now() - 6900000).toISOString() },
    { id: "018f6f18-24d7-7c21-9b62-8c0174199523", conversation_id: DIRECT, sequence: 3, author_identity_id: MEI, author_kind: "user", content: "设计稿也在这里，确认后我更新团队网盘。", attachments: [{ object_id: "018f6f18-24d7-7c21-9b62-8c0174199531", object_version: 2, filename: "launch-cover.png", media_type: "image/png", byte_size: 248320, sha256: `sha256:${"a".repeat(64)}` }], created_at: new Date(Date.now() - 6600000).toISOString() },
  ]],
  [GROUP, [
    { id: "018f6f18-24d7-7c21-9b62-8c0174199524", conversation_id: GROUP, sequence: 1, author_identity_id: BOT, author_kind: "application", application_key: "bot.release", content: "夜间构建已完成，全部检查通过。", attachments: [], created_at: new Date(Date.now() - 5600000).toISOString() },
    { id: "018f6f18-24d7-7c21-9b62-8c0174199525", conversation_id: GROUP, sequence: 2, author_identity_id: MEI, author_kind: "user", content: "明早一起做最终验收。", attachments: [], created_at: new Date(Date.now() - 5400000).toISOString() },
  ]],
]);
const identities = [
  { id: SELF, display_name: "林默", username: "linmo" },
  { id: MEI, display_name: "陈玫", username: "chenmei" },
  { id: BOT, display_name: "发布助手", username: "release-bot" },
];
const notifications = [{ id: "018f6f18-24d7-7c21-9b62-8c0174199541", conversation_id: GROUP, message_id: "018f6f18-24d7-7c21-9b62-8c0174199525", kind: "message", created_at: new Date(Date.now() - 5400000).toISOString(), read_at: null }];

function send(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...headers });
  response.end(body);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://fixture.invalid");
  if (request.method === "GET" && url.pathname === "/api/v1/session/bootstrap") return send(response, 200, { actor: { identity_id: SELF } }, { "set-cookie": "__Host-teamaibox-csrf=visual-fixture; Path=/; Secure; SameSite=Strict" });
  if (request.method === "GET" && url.pathname === "/api/v1/messaging/conversations") return send(response, 200, { data: conversations });
  if (request.method === "GET" && url.pathname === "/api/v1/identities") return send(response, 200, { data: identities, meta: { actor_identity_id: SELF } });
  if (request.method === "GET" && url.pathname === "/api/v1/identities/search") return send(response, 200, { data: identities.filter((value) => value.id !== SELF) });
  if (request.method === "GET" && url.pathname === "/api/v1/messaging/presence") return send(response, 200, { data: [{ identity_id: MEI, state: "online" }, { identity_id: BOT, state: "away" }] });
  if (request.method === "GET" && url.pathname === "/api/v1/messaging/notifications") return send(response, 200, { data: notifications.filter((value) => !value.read_at) });
  if (request.method === "GET" && url.pathname === "/api/v1/messaging/search") {
    const query = (url.searchParams.get("q") || "").toLocaleLowerCase();
    return send(response, 200, { data: [...messages.values()].flat().filter((value) => value.content.toLocaleLowerCase().includes(query)) });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/messaging/events") {
    response.writeHead(200, { "cache-control": "no-store", connection: "keep-alive", "content-type": "text/event-stream", "x-accel-buffering": "no" });
    response.write(": visual fixture ready\n\n");
    return;
  }
  const history = url.pathname.match(/^\/api\/v1\/messaging\/conversations\/([0-9a-f-]+)\/messages$/);
  const notificationRead = url.pathname.match(/^\/api\/v1\/messaging\/notifications\/([0-9a-f-]+)\/read$/);
  if (request.method === "POST" && notificationRead) {
    const value = notifications.find((item) => item.id === notificationRead[1]);
    if (!value) return send(response, 404, { error: { code: "not_found" } });
    value.read_at ||= new Date().toISOString(); return send(response, 200, value);
  }
  if (request.method === "GET" && history) return send(response, 200, { data: messages.get(history[1]) || [] });
  if (request.method === "POST" && history) {
    const value = await body(request), values = messages.get(history[1]) || [];
    const sent = { id: crypto.randomUUID(), conversation_id: history[1], sequence: values.length + 1, author_identity_id: SELF, author_kind: "user", content: value.content, attachments: [], created_at: new Date().toISOString() };
    values.push(sent); messages.set(history[1], values); return send(response, 200, sent);
  }
  if (request.method === "GET" && (url.pathname === "/plugins/official.messaging" || url.pathname.startsWith("/plugins/official.messaging/"))) {
    const relative = url.pathname === "/plugins/official.messaging" || url.pathname.endsWith("/") ? "index.html" : url.pathname.slice("/plugins/official.messaging/".length);
    if (!new Set(["index.html", "app.css", "focus.css", "app.js", "preferences-v1.mjs", "platform-preferences.css","ui-system.css"]).has(relative)) return send(response, 404, { error: { code: "not_found" } });
    const shared = applicationPluginSharedAsset(relative);
    if (shared) {
      response.writeHead(200, { "cache-control": "no-store", "content-length": shared.body.byteLength, "content-type": shared.contentType, "x-content-type-options": "nosniff" });
      response.end(shared.body);
      return;
    }
    const file = resolve(root, relative), metadata = await stat(file);
    const extension = extname(file), prefix = extension === ".css" ? "[hidden]{display:none!important}\n" : "";
    response.writeHead(200, { "cache-control": "no-store", "content-length": metadata.size + Buffer.byteLength(prefix), "content-type": extension === ".html" ? "text/html; charset=utf-8" : extension === ".css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
    if (prefix) response.write(prefix);
    return createReadStream(file).pipe(response);
  }
  send(response, 404, { error: { code: "not_found" } });
});

server.listen(Number.parseInt(process.env.PORT || "18083", 10), "127.0.0.1");
