import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { HmacNodeAgentCommandSigner } from "../src/node-agent-command-signer.mjs";

test("HMAC signer authenticates the exact Node Agent transport bytes", async () => {
  const key = Buffer.alloc(32, 7), commandId = "00000000-0000-4000-8000-000000000101";
  const deadlineAt = "2026-08-13T08:01:00.000Z";
  const body = JSON.stringify({ commandId, deadlineAt, payload: { workerId: "worker-a" } });
  const proof = await new HmacNodeAgentCommandSigner({ keyId: "scheduler-a", key,
    nonceFactory: () => "fixed_nonce_0000000000000001" }).sign({ body, commandId, deadlineAt });
  const expected = createHmac("sha256", key).update(`scheduler-a\n${proof.nonce}\n`).update(body).digest("base64url");
  assert.equal(proof.signature, expected);
  assert.equal(proof.keyId, "scheduler-a");
});

test("HMAC signer rejects facts that differ from the signed body", async () => {
  const signer = new HmacNodeAgentCommandSigner({ keyId: "scheduler-a", key: Buffer.alloc(32, 1) });
  const body = JSON.stringify({ commandId: "00000000-0000-4000-8000-000000000101", deadlineAt: "2026-08-13T08:01:00.000Z" });
  await assert.rejects(signer.sign({ body, commandId: "00000000-0000-4000-8000-000000000102", deadlineAt: "2026-08-13T08:01:00.000Z" }), /do not match/);
});
