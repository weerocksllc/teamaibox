#!/usr/bin/env node
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("input and output paths are required");
const plaintext = await readFile(inputPath);
if (plaintext.byteLength < 1 || plaintext.byteLength > 64 * 1024 * 1024) throw new Error("artifact boundary is invalid");
const key = randomBytes(32), nonce = randomBytes(12);
try {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([Buffer.from("TEAMAIBOX-AES-256-GCM-V1\0"), nonce, tag, encrypted]);
  await writeFile(outputPath, envelope, { mode: 0o600, flag: "wx" });
  process.stdout.write(JSON.stringify({
    algorithm: "AES-256-GCM",
    plaintextSha256: `sha256:${createHash("sha256").update(plaintext).digest("hex")}`,
    ciphertextSha256: `sha256:${createHash("sha256").update(envelope).digest("hex")}`,
    plaintextSizeBytes: plaintext.byteLength,
    ciphertextSizeBytes: envelope.byteLength,
    authenticationTagBytes: tag.byteLength,
    keyRetained: false,
  }));
  encrypted.fill(0); envelope.fill(0); tag.fill(0);
} finally {
  plaintext.fill(0); key.fill(0); nonce.fill(0);
}
