import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = await readFile(new URL("../../../deploy/unlock/compose.yaml", import.meta.url), "utf8");
const server = await readFile(new URL("../server/https-server.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../public/app.css", import.meta.url), "utf8");

test("pre-unlock container has only TLS audit and helper-socket mounts", () => {
  assert.doesNotMatch(compose, /TEAMAIBOX_DATA_ROOT|docker\.sock|privileged:/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.match(compose, /helper\.sock}:/);
  assert.match(compose, /pre-unlock-only: "true"/);
});

test("LOCKED deployment exposes no protected data service or protected volume", () => {
  assert.doesNotMatch(compose, /postgres|event-bus|object-service|scheduler|agent-bridge|plugin-runtime|TEAMAIBOX_DATA_ROOT/);
  assert.match(compose, /services:\n  unlock-service:/);
});

test("unlock transport is TLS 1.3 and never offers a plaintext listener", () => {
  assert.match(server, /createServer\(\{ key: tls\.key, cert: tls\.cert, minVersion: "TLSv1\.3"/);
  assert.doesNotMatch(server, /node:http"|createServer\(\s*\(request/);
  assert.match(compose, /TEAMAIBOX_UNLOCK_TLS_SERVER_NAME/);
  assert.doesNotMatch(compose, /NODE_TLS_REJECT_UNAUTHORIZED/);
});

test("Web unlock is self-contained bilingual and Light Dark capable", () => {
  assert.doesNotMatch(html + app + css, /https?:\/\//);
  assert.match(app, /"zh-CN"/);
  assert.match(app, /en:/);
  assert.match(css, /data-theme=dark/);
  assert.match(html, /type="password"/);
  assert.match(html, /LUKS2/);
});
