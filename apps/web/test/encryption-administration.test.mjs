import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../src/encryption/EncryptionAdministrationPanel.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/encryption/encryption-client.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const i18n = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");

test("encryption administration is an enabled real administrator domain", () => {
  assert.match(app, /availableAdminDomains[^;]+"encryption"/s);
  assert.match(app, /selected\?\.id === "encryption"/);
  assert.match(app, /EncryptionAdministrationPanel locale=\{locale\} canManage=\{canManage\}/);
  assert.match(client, /\/api\/v1\/admin\/encryption\/status/);
  assert.match(client, /\/api\/v1\/admin\/encryption\/protection\/enable/);
  assert.match(client, /x-csrf-token/);
});

test("encryption workflow separates at-rest LUKS2 from optional two-phase startup protection", () => {
  assert.match(panel, /blockEncryption/); assert.match(panel, /startupProtection/); assert.match(panel, /capabilities\.transition/);
  assert.match(panel, /PREPARE WEB PASSPHRASE/); assert.doesNotMatch(panel, /PREPARE USB KEY/); assert.match(panel, /ENABLE \$\{prepared\.planId\}/);
  assert.match(panel, /recoveryVerificationId/); assert.match(panel, /selectedVerificationId/); assert.match(panel, /prerequisitesPassed/);
  assert.match(panel, /catch \{ setPrepared\(null\); setCommitConfirmation\(""\); setNotice\(t\("encryption\.action_failed"\)\); await refresh\(\); \}/);
  assert.doesNotMatch(client, /(?:selected|recovery)_(?:secret|key)|keyBytes|rawFactor/i);
});

test("retired hardware mode is not selectable", () => {
  assert.doesNotMatch(panel, /usbKey|usb_key|USB KEY/);
  assert.doesNotMatch(i18n, /encryption\.mode\.usb_/);
  assert.match(client, /"retired"/);
});
