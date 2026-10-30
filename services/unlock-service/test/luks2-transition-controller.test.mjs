import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractControllerJsonLine } from "../src/controller-jsonl-protocol.mjs";
import { Luks2TransitionController } from "../src/luks2-transition-controller.mjs";

test("JSONL controller extraction preserves its frame while wiping the shared input buffer", () => {
  const input = Buffer.from('{"id":"request-1","operation":"status","input":{}}\ntrailing');
  const extracted = extractControllerJsonLine(input);
  assert.deepEqual(JSON.parse(extracted.frame.toString("utf8")), { id: "request-1", operation: "status", input: {} });
  assert.equal(extracted.remainder.toString("utf8"), "trailing");
  assert.ok(input.every((value) => value === 0));
  extracted.frame.fill(0); extracted.remainder.fill(0);
});

test("transition controller accepts only fixed roots and an allowlisted operation surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-controller-test-")), luks = join(root, "luks"), backup = join(root, "backup"), policy = join(root, "policy");
  await Promise.all([mkdir(luks), mkdir(backup), mkdir(policy)]);
  for (const name of ["volume.img", "automatic.key", "recovery.key", "web.key"]) await writeFile(join(luks, name), "fixture");
  const calls = [], runner = { async run(argv) {
    calls.push(argv); const operation = argv[1];
    if (operation === "luksUUID") return { returnCode: 0, stdout: Buffer.from("11111111-2222-4333-8444-555555555555\n") };
    if (operation === "luksDump") return { returnCode: 0, stdout: Buffer.from(JSON.stringify({ keyslots: { 0: {}, 1: {}, 2: {} } })) };
    if (operation === "luksHeaderBackup") { await writeFile(argv.at(-1), "header"); return { returnCode: 0, stdout: Buffer.alloc(0) }; }
    return { returnCode: 0, stdout: Buffer.alloc(0) };
  } };
  const controller = new Luks2TransitionController({ luksRoot: luks, backupRoot: backup, policyRoot: policy, runner });
  const value = await controller.initialize(); assert.equal(value.blockEncryption.status, "verified"); assert.equal(value.startupProtection.enabled, false);
  await assert.rejects(controller.handle("shell", {}), /not allowlisted/);
  assert.ok(calls.every((item) => item[0] === "cryptsetup"));
});
