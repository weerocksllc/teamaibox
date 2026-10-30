import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, readFile } from "node:fs/promises";

const port = Number.parseInt(process.env.BROWSER_CANARY_PORT ?? "8080", 10);
const statePath = "/var/lib/teamaibox-browser-canary/schema";
const activityPath = "/var/lib/teamaibox-browser-canary/activity";
const users = new Map([["owner", "owner"], ["member", "member"]]);
const sessions = new Map();

const html = String.raw`<!doctype html>
<html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Team AI Box Browser Runner Canary</title><style>
:root{color-scheme:light;--bg:#f5f7f6;--fg:#15201b;--card:#fff;--accent:#16845b}:root[data-theme=dark]{color-scheme:dark;--bg:#101512;--fg:#eef7f1;--card:#19221d;--accent:#74d9ac}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui}.shell{width:100%;max-width:900px;margin:auto;padding:32px}.card{width:100%;background:var(--card);border:1px solid color-mix(in srgb,var(--fg) 18%,transparent);border-radius:18px;padding:24px;margin:16px 0}.card,form,label{min-width:0}label{display:block;margin:12px 0}input,select,button,a{font:inherit}input,select{max-width:100%;padding:10px;border:1px solid #87968e;border-radius:8px}select{min-width:120px}input[type=file]{width:100%;min-width:min(240px,100%)}button,.button{display:inline-block;padding:10px 16px;border:0;border-radius:9px;background:var(--accent);color:var(--bg);font-weight:700;text-decoration:none;margin:4px}.row{display:flex;flex-wrap:wrap;gap:12px;align-items:end}.status{min-height:28px;font-weight:700}:focus-visible{outline:3px solid #ef9f1a;outline-offset:3px}@media(max-width:520px){.shell{padding:14px}.card{padding:18px}.row>*{width:100%}}
</style></head><body><main class="shell"><h1 data-testid="title">Browser Acceptance Canary</h1>
<section id="signin" class="card"><h2>Sign in</h2><form data-testid="sign-in-form"><label>Username <input data-testid="username" autocomplete="username"></label><label>Password <input data-testid="password" type="password" autocomplete="current-password"></label><button data-testid="sign-in" type="submit">Sign in</button></form><p class="status" data-testid="auth-status" role="status"></p></section>
<section id="workspace" class="card" hidden><h2 data-testid="workspace-title">Workspace</h2><p data-testid="identity"></p><div class="row"><label>Locale <select data-testid="locale"><option value="zh-CN">简体中文</option><option value="en">English</option></select></label><label>Theme <select data-testid="theme"><option value="light">Light</option><option value="dark">Dark</option></select></label></div>
<form data-testid="upload-form"><label>Upload <input data-testid="upload-input" type="file"></label><button data-testid="upload" type="submit">Upload</button></form><p class="status" data-testid="upload-status" role="status"></p>
<a class="button" data-testid="download" href="/download">Download</a><button data-testid="sse" type="button">Test SSE</button><button data-testid="websocket" type="button">Test WebSocket</button><button data-testid="sign-out" type="button">Sign out</button><p class="status" data-testid="transport-status" role="status"></p></section></main>
<script>
const q=x=>document.querySelector('[data-testid="'+x+'"]');
function restorePreferences(){const locale=localStorage.getItem('canary-locale');const theme=localStorage.getItem('canary-theme');if(['zh-CN','en'].includes(locale)){q('locale').value=locale;document.documentElement.lang=locale}if(['light','dark'].includes(theme)){q('theme').value=theme;document.documentElement.dataset.theme=theme}}
async function bootstrap(){const r=await fetch('/api/session');if(!r.ok)return;const v=await r.json();q('sign-in-form').parentElement.hidden=true;q('workspace-title').parentElement.hidden=false;q('identity').textContent=v.username+' · '+v.role;}
q('sign-in-form').addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/api/sign-in',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:q('username').value,password:q('password').value})});q('password').value='';q('auth-status').textContent=r.ok?'signed-in':'denied';if(r.ok)await bootstrap()});
q('locale').addEventListener('change',e=>{localStorage.setItem('canary-locale',e.target.value);document.documentElement.lang=e.target.value});q('theme').addEventListener('change',e=>{localStorage.setItem('canary-theme',e.target.value);document.documentElement.dataset.theme=e.target.value});
q('upload-form').addEventListener('submit',async e=>{e.preventDefault();const f=q('upload-input').files[0];const r=await fetch('/upload',{method:'POST',body:f??new Blob()});q('upload-status').textContent=r.ok?'upload-ok':'upload-failed'});
q('sse').addEventListener('click',()=>{const s=new EventSource('/events');s.onmessage=e=>{q('transport-status').textContent=e.data;s.close()};s.onerror=()=>q('transport-status').textContent='sse-failed'});
q('websocket').addEventListener('click',()=>{const s=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');s.onmessage=e=>{q('transport-status').textContent=e.data;s.close()};s.onerror=()=>q('transport-status').textContent='websocket-failed'});
q('sign-out').addEventListener('click',async()=>{await fetch('/api/sign-out',{method:'POST'});location.reload()});restorePreferences();bootstrap();
</script></body></html>`;

function cookies(request) { return Object.fromEntries(String(request.headers.cookie ?? "").split(";").map(x => x.trim().split("=")).filter(x => x.length === 2)); }
function session(request) { return sessions.get(cookies(request).canary_session) ?? null; }
function send(response, status, body, headers = {}) { const bytes = Buffer.from(body); response.writeHead(status, { "content-length": bytes.length, ...headers }); response.end(bytes); }
async function jsonBody(request) { const chunks=[]; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString("utf8")); }

const server = createServer(async (request, response) => {
  if (request.url === "/health/ready") { const schema = await readFile(statePath, "utf8").catch(() => ""); return send(response, schema === "browser-schema-v1\n" ? 200 : 503, "{}", {"content-type":"application/json"}); }
  if (request.method === "GET" && request.url === "/") return send(response, 200, html, {"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
  if (request.method === "POST" && request.url === "/api/sign-in") { const body=await jsonBody(request).catch(()=>({})); const role=users.get(body.username); if(!role||body.password!=="acceptance-only")return send(response,401,'{"error":"denied"}',{"content-type":"application/json"}); const token=createHash("sha256").update(body.username+Date.now()).digest("hex");sessions.set(token,{username:body.username,role});await appendFile(activityPath,`signin:${role}\n`);return send(response,200,'{"ok":true}',{"content-type":"application/json","set-cookie":`canary_session=${token}; HttpOnly; SameSite=Strict; Path=/`}); }
  if (request.method === "POST" && request.url === "/api/sign-out") { sessions.delete(cookies(request).canary_session);return send(response,204,"",{"set-cookie":"canary_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/"}); }
  const actor=session(request);if(!actor)return send(response,401,'{"error":"authentication_required"}',{"content-type":"application/json"});
  if (request.method === "GET" && request.url === "/api/session") return send(response,200,JSON.stringify(actor),{"content-type":"application/json"});
  if (request.method === "POST" && request.url === "/upload") { let size=0;for await(const chunk of request)size+=chunk.length;await appendFile(activityPath,`upload:${actor.role}:${size}\n`);return send(response,200,'{"ok":true}',{"content-type":"application/json"}); }
  if (request.method === "GET" && request.url === "/download") return send(response,200,"browser-canary-download\n",{"content-type":"text/plain","content-disposition":"attachment; filename=canary.txt"});
  if (request.method === "GET" && request.url === "/events") { response.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-store","connection":"keep-alive"});response.end("data: sse-ok\n\n");return; }
  send(response,404,"not found");
});

server.on("upgrade", (request, socket) => {
  if (request.url !== "/ws" || !session(request)) return socket.destroy();
  const accept=createHash("sha1").update(request.headers["sec-websocket-key"]+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const payload=Buffer.from("websocket-ok");socket.write(Buffer.concat([Buffer.from([0x81,payload.length]),payload]));setTimeout(()=>socket.end(),100);
});
server.listen(port,"0.0.0.0");
