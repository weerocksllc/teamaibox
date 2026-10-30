import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadAgentIdentities, parseAgentIdentities } from "./product-agent-identities.mjs";

const mapping = () => {
  const key = `worker-${randomBytes(8).toString("hex")}`;
  return { loginName: `operator-${randomBytes(8).toString("hex")}`, key, proxyOrigin: `http://${key}.invalid:8080` };
};

test("explicit agent mappings are validated and immutable, with no fallback", async () => {
  const values = [mapping(), mapping()];
  const parsed = parseAgentIdentities(JSON.stringify(values));
  assert.deepEqual(parsed, values); assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed[0]));
  for (const value of [undefined, "", "relative.json"]) await assert.rejects(loadAgentIdentities(value), /TEAMAIBOX_AGENT_IDENTITIES_FILE/);
  for (const value of ["", "{}", "[]", "null"]) assert.throws(() => parseAgentIdentities(value), /explicit/);
});

test("agent mappings reject ambiguous routing, traversal, credential URLs and unknown fields", () => {
  const item = mapping();
  const bad = [
    [item, { ...mapping(), loginName: item.loginName }],
    [item, { ...mapping(), key: item.key }],
    [item, { ...mapping(), proxyOrigin: item.proxyOrigin }],
    [{ ...item, key: "../outside" }], [{ ...item, loginName: "not a login" }],
    [{ ...item, key: [item.key] }], [{ ...item, loginName: [item.loginName] }],
    [{ ...item, proxyOrigin: "file:///etc/config" }],
    [{ ...item, proxyOrigin: "https://account:placeholder@unit.invalid" }],
    [{ ...item, proxyOrigin: item.proxyOrigin + "/nested" }],
    [{ ...item, proxyOrigin: item.proxyOrigin + "?q=1" }],
    [{ ...item, password: randomBytes(32).toString("hex") }],
  ];
  for (const value of bad) assert.throws(() => parseAgentIdentities(JSON.stringify(value)), /explicit/);
});

test("configuration loader accepts only bounded owner-only regular files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-identities-test-"));
  try {
    const filename = join(directory, "identities.json"), link = join(directory, "linked.json"), value = [mapping()];
    await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
    assert.deepEqual(await loadAgentIdentities(filename), value);
    await symlink(filename, link);
    await assert.rejects(loadAgentIdentities(link), /unsafe or invalid/);
    await chmod(filename, 0o644);
    await assert.rejects(loadAgentIdentities(filename), /unsafe or invalid/);
    await chmod(filename, 0o600);
    await writeFile(filename, Buffer.alloc(65_537, 32));
    await assert.rejects(loadAgentIdentities(filename), /unsafe or invalid/);
    await assert.rejects(loadAgentIdentities(directory), /unsafe or invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
