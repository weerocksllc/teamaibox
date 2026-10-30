import { createReadStream, readFileSync, realpathSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
});

// Application plugins use the native `hidden` attribute for mutually exclusive
// views, progress panels, dialogs, and errors. Author-level layout declarations
// such as `display: grid` can otherwise override the user-agent rule.
const PLUGIN_STATE_CSS = "[hidden]{display:none!important}\n";
const PREFERENCE_CLIENT = readFileSync(new URL("../../plugin-sdk/src/preferences-v1.mjs", import.meta.url));
const UPLOAD_CLIENT = readFileSync(new URL("../../plugin-sdk/src/object-upload.mjs", import.meta.url));
const INSTALLATION_UPLOAD_CLIENT = readFileSync(new URL("../../plugin-sdk/src/installation-upload.mjs", import.meta.url));
const SHA256_CLIENT = readFileSync(new URL("../../plugin-sdk/src/sha256.mjs", import.meta.url));
const LOCALE_ASSETS = new Map(["locale-registry.mjs", "product-localization.mjs", "global-translations.mjs"].map(name => [name, readFileSync(new URL(`../../ui-system/src/${name}`, import.meta.url))]));
const UI_STYLES = Buffer.concat(["tokens.css", "primitives.css", "preferences.css", "applications.css", "premium-interiors.css"].map(name =>
  readFileSync(new URL(`../../ui-system/src/${name}`, import.meta.url))));
const PREFERENCE_ALIASES = Buffer.from(`
:root[data-plugin-preference-revision]{
  --bg:var(--teamaibox-canvas);--panel:var(--teamaibox-surface);--panel2:var(--teamaibox-surface-subtle);
  --panel3:var(--teamaibox-surface-raised);--text:var(--teamaibox-text);--muted:var(--teamaibox-text-muted);
  --line:var(--teamaibox-border);--accent:var(--teamaibox-interactive);--accent2:var(--teamaibox-interactive-hover);
  --accent-soft:var(--teamaibox-selected-surface);--soft:var(--teamaibox-selected-surface);
  --danger:var(--teamaibox-error);--warning:var(--teamaibox-warning);--warn:var(--teamaibox-warning);
  --good:var(--teamaibox-success);--blue:var(--teamaibox-info);--shadow:var(--teamaibox-shadow-lg);
  --own:var(--teamaibox-interactive);--own-text:var(--teamaibox-on-interactive)
}
`, "utf8");

export function applicationPluginSharedAsset(relative) {
  if (LOCALE_ASSETS.has(relative)) return { body: Buffer.from(LOCALE_ASSETS.get(relative)), contentType: "text/javascript; charset=utf-8" };
  if (relative === "ui-system.css") return { body: Buffer.from(UI_STYLES), contentType: "text/css; charset=utf-8" };
  if (relative === "object-upload.mjs") return { body: Buffer.from(UPLOAD_CLIENT), contentType: "text/javascript; charset=utf-8" };
  if (relative === "installation-upload.mjs") return { body: Buffer.from(INSTALLATION_UPLOAD_CLIENT), contentType: "text/javascript; charset=utf-8" };
  if (relative === "sha256.mjs") return { body: Buffer.from(SHA256_CLIENT), contentType: "text/javascript; charset=utf-8" };
  if (relative === "preferences-v1.mjs") return { body: Buffer.from(PREFERENCE_CLIENT), contentType: "text/javascript; charset=utf-8" };
  if (relative === "platform-preferences.css") return { body: Buffer.from(PREFERENCE_ALIASES), contentType: "text/css; charset=utf-8" };
  return null;
}

function json(response, status, value) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

export function createStaticApplicationPluginServer({ pluginId, version, publicRoot }) {
  if (!/^[a-z][a-z0-9.-]{2,127}$/.test(pluginId) || typeof version !== "string" || !version) {
    throw new TypeError("application plugin identity is invalid");
  }
  const root = realpathSync(resolve(publicRoot));
  const prefix = `/plugins/${pluginId}`;

  function sharedAsset(request, response, pathname) {
    if (!pathname.startsWith(`${prefix}/`)) return false;
    const asset = applicationPluginSharedAsset(pathname.slice(prefix.length + 1));
    if (!asset) return false;
    response.writeHead(200, {
      // These URLs are stable across deployments, not content-fingerprinted.
      // A new HTML document must never execute a five-minute-old module.
      "cache-control": "no-cache",
      "content-length": asset.body.byteLength,
      "content-type": asset.contentType,
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : asset.body);
    return true;
  }

  async function safeAsset(pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.includes("\0") || !(decoded === prefix || decoded.startsWith(prefix + "/"))) return null;
    const relative = decoded === prefix || decoded === prefix + "/" ? "index.html" : decoded.slice(prefix.length + 1);
    const candidate = resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(root + sep)) return null;
    try {
      const link = await lstat(candidate);
      if (link.isSymbolicLink()) return null;
      const actual = await realpath(candidate);
      if (actual !== root && !actual.startsWith(root + sep)) return null;
      const metadata = await stat(actual);
      return metadata.isFile() ? { actual, metadata } : null;
    } catch { return null; }
  }

  return createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://plugin.invalid").pathname;
    if (request.method === "GET" && new Set(["/health/startup", "/health/ready", "/health/live"]).has(pathname)) {
      json(response, 200, { status: "ready", pluginId, version });
      return;
    }
    if (!new Set(["GET", "HEAD"]).has(request.method || "GET")) {
      response.setHeader("allow", "GET, HEAD");
      json(response, 405, { error: { code: "method_not_allowed" } });
      return;
    }
    if (sharedAsset(request, response, pathname)) return;
    const asset = await safeAsset(pathname);
    if (!asset) {
      json(response, 404, { error: { code: "not_found" } });
      return;
    }
    const extension = extname(asset.actual);
    const prefix = extension === ".css" ? PLUGIN_STATE_CSS : "";
    response.writeHead(200, {
      "cache-control": extension === ".html" ? "no-store" : "no-cache",
      "content-length": asset.metadata.size + Buffer.byteLength(prefix),
      "content-type": TYPES[extension] || "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else {
      if (prefix) response.write(prefix);
      createReadStream(asset.actual).pipe(response);
    }
  });
}
