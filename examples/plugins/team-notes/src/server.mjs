import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const pluginVersion = process.env.TEAMAIBOX_PLUGIN_VERSION ?? "development";
const pluginHealth = process.env.TEAMAIBOX_PLUGIN_HEALTH ?? "ready";
const browserSource = await readFile(new URL("./browser.mjs", import.meta.url), "utf8");
const preferencesSource = await readFile(new URL("../../../../packages/plugin-sdk/src/preferences-v1.mjs", import.meta.url), "utf8");
const stylesheetSource = await readFile(new URL("./styles.css", import.meta.url), "utf8");

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function html(requestUrl) {
  const theme = new URL(requestUrl, "http://plugin.invalid").searchParams.get("theme") === "dark" ? "dark" : "light";
  return `<!doctype html>
<html lang="en" dir="ltr" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Team Notes sample</title>
<link rel="stylesheet" href="/plugins/example.team-notes/styles.css">
</head><body><main><h1>Team Notes sample</h1><p>This third-party ApplicationPlugin is ready.</p><p>Version <code>${escapeHtml(pluginVersion)}</code></p><p>Its host integration uses <code>createTeamNotesApplication</code> and a request-bound user delegation.</p><label for="note-draft"><span>Draft note</span><input id="note-draft" autocomplete="off" value=""></label><p class="status"><span><small>Requested locale</small><code id="requested-locale">pending</code></span><span><small>Effective locale</small><code id="effective-locale">en</code></span><span><small>Theme</small><code id="effective-theme">${theme}</code></span><span><small>Revision</small><code id="preference-revision">0</code></span></p></main><script type="module" src="/plugins/example.team-notes/browser.mjs"></script></body></html>`;
}

export function createTeamNotesServer() {
  return createServer((request, response) => {
    const path = new URL(request.url, "http://plugin.invalid").pathname;
    if (request.method === "GET" && new Set(["/health/startup", "/health/ready", "/health/live"]).has(path)) {
      const healthy = pluginHealth === "ready";
      response.writeHead(healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: healthy ? "ready" : "unhealthy", pluginId: "example.team-notes" }));
      return;
    }
    if (request.method === "GET" && (path === "/" || path === "/plugins/example.team-notes")) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors 'self'",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(html(request.url));
      return;
    }
    if (request.method === "GET" && path === "/plugins/example.team-notes/browser.mjs") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(browserSource);
      return;
    }
    if (request.method === "GET" && path === "/plugins/example.team-notes/preferences-v1.mjs") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(preferencesSource);
      return;
    }
    if (request.method === "GET" && path === "/plugins/example.team-notes/styles.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(stylesheetSource);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found" } }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createTeamNotesServer().listen(port, "0.0.0.0");
}
