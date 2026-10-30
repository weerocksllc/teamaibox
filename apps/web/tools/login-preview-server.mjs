// Isolated visual fixture. Never proxies the appliance or accepts real sign-ins.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { supportedLocaleCodes } from '../../../packages/ui-system/src/locale-registry.mjs';

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const port = Number(process.env.TEAMAIBOX_LOGIN_PREVIEW_PORT || 4190);
let signedIn = false;
const preferences = { preferredLocale: "zh-CN", preferredTheme: "light" };
const session = () => ({ authenticated: true, identity: { id: "019fea17-b280-7e82-ac11-8601d2fe7274", identityKind: "local_user", loginName: "appearance-preview", displayName: "外观验证账户", roles: ["member"] }, permissions: ["application:catalog:view"], teamMemberships: [], teamRoles: {}, preferences });
const types = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".html": "text/html", ".png": "image/png" };
const json = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
};
createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const mode = new URL(request.headers.referer || url).searchParams.get("state");
  if (url.pathname.startsWith("/api/")) {
    if (request.method === "POST" && url.pathname === "/api/auth/sign-in") {
      let raw = "";
      for await (const part of request) { raw += part; if (raw.length > 4096) return json(response, 413, {}); }
      let input; try { input = JSON.parse(raw); } catch { return json(response, 400, {}); }
      // Public, fixture-only values. No real accounts and no upstream API.
      if (input.loginName !== "appearance-preview" || input.password !== "fixture-only") return json(response, 401, { error: { code: "invalid_credentials" } });
      signedIn = true;
      response.setHeader("Set-Cookie", "__Host-teamaibox-csrf=visual-fixture; Path=/; Secure; SameSite=Strict");
      return json(response, 200, session());
    }
    if (request.method === "PATCH" && signedIn && ["/api/preferences/theme", "/api/preferences/locale"].includes(url.pathname)) {
      let raw = ""; for await (const part of request) { raw += part; if (raw.length > 4096) return json(response, 413, {}); }
      let input; try { input = JSON.parse(raw); } catch { return json(response, 400, {}); }
      if (["light", "dark", "system"].includes(input.theme)) preferences.preferredTheme = input.theme;
      if (supportedLocaleCodes.includes(input.locale)) preferences.preferredLocale = input.locale;
      return json(response, 200, preferences);
    }
    if (request.method === "POST" && url.pathname === "/api/auth/sign-out") { signedIn = false; return json(response, 200, {}); }
    if (request.method !== "GET") return json(response, 401, { error: { code: "invalid_credentials" } });
    if (url.pathname === "/api/auth/session") return mode === "unavailable" ? json(response, 503, {}) : signedIn ? json(response, 200, session()) : json(response, 401, {});
    if (url.pathname === "/api/setup/status") return json(response, 200, { required: mode === "setup", claimProtected: true, ownerRecoveryAvailable: true });
    if (url.pathname === "/api/v1/applications") return json(response, 200, { applications: [] });
    return json(response, 404, {});
  }
  if (url.pathname === "/runtime-config.js") {
    response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
    return response.end('globalThis.__TEAM_AI_BOX_RUNTIME__=Object.freeze({apiBase:"/api",classification:"isolated-development-synthetic-only",deploymentSlot:"preview",mode:"development",releaseEvidenceEligible:false,releaseId:"login-visual-preview",transport:"https"});');
  }
  const path = resolve(root, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
  if (!path.startsWith(`${resolve(root)}${sep}`)) return json(response, 404, {});
  try {
    const body = await readFile(path);
    response.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'" });
    response.end(body);
  } catch { json(response, 404, {}); }
}).listen(port, "127.0.0.1", () => console.log(`Login-only visual fixture: http://127.0.0.1:${port}`));
