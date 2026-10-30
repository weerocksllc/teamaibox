import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  OwnerRecoveryAuthorityError,
  OwnerRecoveryProofAuthority,
} from "../src/identity/owner-recovery-authority.mjs";

test("binds a short-lived local proof to one browser challenge and rejects replay", async () => {
  let current = new Date("2026-08-25T00:00:00.000Z");
  const authority = new OwnerRecoveryProofAuthority(randomBytes(48).toString("base64url"), {
    clock: () => new Date(current),
  });
  const first = authority.createChallenge({ networkIdentifier: "lan-a" });
  const second = authority.createChallenge({ networkIdentifier: "lan-b" });
  const proof = authority.issueProof(first.challenge);
  assert.equal(await authority.verify({ challenge: second.challenge, proof }), false);
  assert.equal(await authority.verify({ challenge: first.challenge, proof }), true);
  assert.equal(await authority.verify({ challenge: first.challenge, proof }), false);
  current = new Date(current.getTime() + 5 * 60 * 1000 + 1);
  const expiredProof = authority.issueProof(second.challenge);
  assert.equal(await authority.verify({ challenge: second.challenge, proof: expiredProof }), false);
  authority.close();
  assert.equal(await authority.verify({ challenge: second.challenge, proof: expiredProof }), false);
});

test("rate limits challenge creation per network without returning key material", () => {
  const key = randomBytes(48).toString("base64url");
  const authority = new OwnerRecoveryProofAuthority(key, { networkChallengeLimit: 2 });
  authority.createChallenge({ networkIdentifier: "lan-a" });
  authority.createChallenge({ networkIdentifier: "lan-a" });
  assert.throws(
    () => authority.createChallenge({ networkIdentifier: "lan-a" }),
    (error) => error instanceof OwnerRecoveryAuthorityError && error.code === "recovery_throttled" && error.status === 429,
  );
  assert.equal(JSON.stringify(authority).includes(key), false);
  authority.close();
});

test("loads the recovery proof key from an absolute protected file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-owner-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "owner-recovery-key");
  await writeFile(path, randomBytes(48).toString("base64url"), { mode: 0o400 });
  const authority = await OwnerRecoveryProofAuthority.fromFile(path);
  const challenge = authority.createChallenge();
  assert.equal(await authority.verify({ challenge: challenge.challenge, proof: authority.issueProof(challenge.challenge) }), true);
  authority.close();
});
