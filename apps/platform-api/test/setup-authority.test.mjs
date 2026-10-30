import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { OwnerSetupTokenAuthority } from "../src/identity/setup-authority.mjs";

test("owner setup authority accepts one high-entropy device token without exposing it", async () => {
  const token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
  const authority = new OwnerSetupTokenAuthority(token);
  assert.equal(await authority.verify(token), true);
  assert.equal(await authority.verify(token + "x"), false);
  assert.equal(await authority.verify("short"), false);
  assert.equal(JSON.stringify(authority).includes(token), false);
  authority.close();
  assert.equal(await authority.verify(token), false);
});

test("owner setup authority rejects weak token material", () => {
  assert.throws(() => new OwnerSetupTokenAuthority("short"), /high-entropy/);
});

test("owner setup authority hashes a token file without retaining its plaintext buffer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-owner-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "setup-token");
  const token = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0F9e";
  await writeFile(path, `\n${token}\r\n`, { mode: 0o600 });
  const authority = await OwnerSetupTokenAuthority.fromFile(path);
  assert.equal(await authority.verify(token), true);
  assert.equal(JSON.stringify(authority).includes(token), false);
  authority.close();
  authority.close();
});
