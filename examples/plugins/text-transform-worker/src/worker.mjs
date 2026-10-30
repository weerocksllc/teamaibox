import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  assertWorkerControlRequestV1,
  createWorkerControlResponseV1,
} from "../../../../packages/plugin-sdk/src/worker-control-v1.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAXIMUM_CHUNK_BYTES = 256 * 1024;

function failureCode(error) {
  return typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(error.code)
    ? error.code : "object_transfer_invalid";
}

function transferError(code, message) {
  return Object.assign(new Error(message), { code });
}

function canonicalChunk(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 384 * 1024
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw transferError("object_chunk_encoding_invalid", "Object chunk is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_CHUNK_BYTES || bytes.toString("base64") !== value) {
    bytes.fill(0);
    throw transferError("object_chunk_size_invalid", "Object chunk exceeds the bounded transfer plane");
  }
  return bytes;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return Object.freeze({ size, digest: `sha256:${hash.digest("hex")}` });
}

export function createTextTransformWorker({ modelProfileId = process.env.TEAMAIBOX_MODEL_PROFILE_ID,
  temporaryDirectory = process.env.TEAMAIBOX_OBJECT_STAGING_DIRECTORY ?? "/tmp/teamaibox-worker-objects",
  storageProbe = statfs } = {}) {
  let prepared = false;
  const active = new Map();
  const transfers = new Map();
  let admittingBytes = 0n;

  async function discard(transferId) {
    const transfer = transfers.get(transferId);
    if (!transfer) return;
    transfers.delete(transferId);
    await transfer.handle?.close?.().catch(() => {});
    transfer.handle = null;
    await unlink(transfer.path).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }

  async function discardAttempt(attemptId) {
    await Promise.all([...transfers.values()].filter((value) => value.attemptId === attemptId)
      .map((value) => discard(value.transferId)));
  }

  async function begin(request) {
    const { transferId, referenceId, role, size, mediaType, integrity } = request.payload;
    if (!prepared) throw transferError("not_prepared", "Worker is not prepared");
    if (!UUID.test(request.attemptId ?? "") || !UUID.test(transferId ?? "") || !UUID.test(referenceId ?? "")
        || typeof role !== "string" || !/^[^\u0000-\u001f\u007f]{1,512}$/u.test(role)
        || !Number.isSafeInteger(size) || size < 1
        || typeof mediaType !== "string" || mediaType.length < 1 || mediaType.length > 255
        || integrity?.algorithm !== "sha256" || !SHA256.test(integrity?.digest ?? "")) {
      throw transferError("object_transfer_metadata_invalid", "Object transfer metadata is invalid");
    }
    if (transfers.has(transferId)) throw transferError("object_transfer_exists", "Object transfer already exists");
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    const storage = await storageProbe(temporaryDirectory, { bigint: true });
    const available = BigInt(storage.bavail) * BigInt(storage.bsize);
    const outstanding = [...transfers.values()].reduce((sum, value) => sum + BigInt(value.size - value.receivedBytes), admittingBytes);
    if (BigInt(size) > available - outstanding) {
      throw transferError("object_transfer_storage_unavailable", "Insufficient staging storage for this transfer");
    }
    const path = join(temporaryDirectory, `${request.attemptId}-${transferId}.part`);
    admittingBytes += BigInt(size);
    try {
      const handle = await open(path, "wx", 0o600);
      transfers.set(transferId, { transferId, referenceId, attemptId: request.attemptId, role, size,
        mediaType, integrity: Object.freeze({ algorithm: "sha256", digest: integrity.digest }),
        receivedBytes: 0, committed: false, path, handle });
    } finally { admittingBytes -= BigInt(size); }
    return createWorkerControlResponseV1(request, { type: "worker.object.begin.accepted",
      payload: { transferId, receivedBytes: 0 } });
  }

  async function chunk(request) {
    const { transferId, offset, bytesBase64, chunkSha256 } = request.payload;
    const transfer = transfers.get(transferId);
    if (!transfer || transfer.attemptId !== request.attemptId || transfer.committed || !transfer.handle) {
      throw transferError("object_transfer_not_writable", "Object transfer is not writable by this attempt");
    }
    if (!Number.isSafeInteger(offset) || offset !== transfer.receivedBytes || !SHA256.test(chunkSha256 ?? "")) {
      throw transferError("object_chunk_offset_invalid", "Object chunk is not contiguous");
    }
    const bytes = canonicalChunk(bytesBase64);
    try {
      if (offset + bytes.byteLength > transfer.size
          || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== chunkSha256) {
        throw transferError("object_chunk_integrity_mismatch", "Object chunk integrity does not match");
      }
      let written = 0;
      while (written < bytes.byteLength) {
        const result = await transfer.handle.write(bytes, written, bytes.byteLength - written, offset + written);
        if (!result.bytesWritten) throw transferError("object_chunk_write_failed", "Object chunk could not be staged");
        written += result.bytesWritten;
      }
      transfer.receivedBytes += bytes.byteLength;
      return createWorkerControlResponseV1(request, { type: "worker.object.chunk.accepted",
        payload: { transferId, receivedBytes: transfer.receivedBytes } });
    } finally { bytes.fill(0); }
  }

  async function commit(request) {
    const { transferId } = request.payload;
    const transfer = transfers.get(transferId);
    if (!transfer || transfer.attemptId !== request.attemptId || transfer.committed || !transfer.handle
        || transfer.receivedBytes !== transfer.size) {
      throw transferError("object_transfer_incomplete", "Object transfer is incomplete");
    }
    await transfer.handle.sync();
    await transfer.handle.close();
    transfer.handle = null;
    const verified = await hashFile(transfer.path);
    if (verified.size !== transfer.size || verified.digest !== transfer.integrity.digest) {
      await discard(transferId);
      throw transferError("object_transfer_integrity_mismatch", "Staged object integrity does not match");
    }
    transfer.committed = true;
    return createWorkerControlResponseV1(request, { type: "worker.object.commit.succeeded",
      payload: { transferId, verifiedBytes: verified.size,
        integrity: { algorithm: "sha256", digest: verified.digest } } });
  }

  async function discardRequested(request) {
    const requested = request.payload.transferIds;
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > 32
        || requested.some((value) => !UUID.test(value ?? ""))) {
      throw transferError("object_discard_invalid", "Object discard request is invalid");
    }
    const owned = [...new Set(requested)].filter((transferId) =>
      transfers.get(transferId)?.attemptId === request.attemptId);
    await Promise.all(owned.map(discard));
    return createWorkerControlResponseV1(request, { type: "worker.object.discard.succeeded",
      payload: { discardedTransferIds: owned } });
  }

  async function consumeInputs(request) {
    const requested = Array.isArray(request.payload.input?.objectInputs)
      ? request.payload.input.objectInputs.filter((value) => value?.transferId !== undefined) : [];
    const facts = [];
    for (const input of requested) {
      const transfer = transfers.get(input.transferId);
      if (!transfer || transfer.attemptId !== request.attemptId || !transfer.committed
          || transfer.referenceId !== input.referenceId || transfer.role !== input.role
          || transfer.size !== input.size || transfer.mediaType !== input.mediaType
          || transfer.integrity.digest !== input.integrity?.digest) {
        throw transferError("object_input_authority_mismatch", "Executable object input is not bound to this attempt");
      }
      const consumed = await hashFile(transfer.path);
      if (consumed.size !== transfer.size || consumed.digest !== transfer.integrity.digest) {
        throw transferError("object_input_integrity_mismatch", "Executable object input changed after commit");
      }
      facts.push(Object.freeze({ role: transfer.role, referenceId: transfer.referenceId,
        transferId: transfer.transferId, size: transfer.size, mediaType: transfer.mediaType,
        integrity: Object.freeze({ ...transfer.integrity }), workerVerified: true }));
    }
    return Object.freeze(facts);
  }

  const succeeded = (request, text, objectInputs) => createWorkerControlResponseV1(request, {
    type: "worker.execute.succeeded",
    payload: { result: { text: text.toUpperCase(),
      ...(objectInputs.length ? { objectInputs: structuredClone(objectInputs) } : {}) }, artifactRefs: [] },
  });

  function hasAttemptTransfers(attemptId) {
    return [...transfers.values()].some((value) => value.attemptId === attemptId);
  }

  function delayedExecution(request, text, objectInputs) {
    const delay = request.payload.input?.x_teamaibox_test_delay_ms;
    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        active.delete(request.attemptId);
        const response = succeeded(request, text, objectInputs);
        await discardAttempt(request.attemptId);
        resolve(response);
      }, delay);
      active.set(request.attemptId, { request, resolve, timer });
    });
  }

  async function executeWithObjects(request) {
    try {
      const objectInputs = await consumeInputs(request);
      const text = typeof request.payload.input?.text === "string" ? request.payload.input.text : "";
      const delay = request.payload.input?.x_teamaibox_test_delay_ms;
      if (Number.isSafeInteger(delay) && delay >= 1 && delay <= 10_000) {
        return delayedExecution(request, text, objectInputs);
      }
      const response = succeeded(request, text, objectInputs);
      await discardAttempt(request.attemptId);
      return response;
    } catch (error) {
      await discardAttempt(request.attemptId);
      return createWorkerControlResponseV1(request, { type: "worker.execute.failed",
        payload: { code: failureCode(error) } });
    }
  }

  return Object.freeze({
    handle(request) {
      assertWorkerControlRequestV1(request);
      if (request.type === "worker.prepare.request") {
        if (request.payload.modelProfileId !== modelProfileId) {
          return createWorkerControlResponseV1(request, { type: "worker.prepare.failed", payload: { code: "profile_mismatch" } });
        }
        prepared = true;
        return createWorkerControlResponseV1(request, {
          type: "worker.prepare.ready",
          payload: { generation: request.payload.generation, modelProfileId,
            capabilityClaims: [{ modelProfileId, operations: ["responses"] }] },
        });
      }
      if (request.type.startsWith("worker.object.")) {
        const operation = request.type.split(".")[2];
        return (async () => {
          try {
            if (operation === "begin") return await begin(request);
            if (operation === "chunk") return await chunk(request);
            if (operation === "commit") return await commit(request);
            if (operation === "discard") return await discardRequested(request);
            throw transferError("object_transfer_operation_invalid", "Object transfer operation is invalid");
          } catch (error) {
            return createWorkerControlResponseV1(request, { type: `worker.object.${operation}.failed`,
              payload: { code: failureCode(error) } });
          }
        })();
      }
      if (request.type === "worker.execute.request") {
        if (!prepared) return createWorkerControlResponseV1(request, { type: "worker.execute.failed", payload: { code: "not_prepared" } });
        const requestedObjects = Array.isArray(request.payload.input?.objectInputs)
          && request.payload.input.objectInputs.some((value) => value?.transferId !== undefined);
        if (requestedObjects) return executeWithObjects(request);
        const text = typeof request.payload.input?.text === "string" ? request.payload.input.text : "";
        const delay = request.payload.input?.x_teamaibox_test_delay_ms;
        if (Number.isSafeInteger(delay) && delay >= 1 && delay <= 10_000) {
          return delayedExecution(request, text, Object.freeze([]));
        }
        return succeeded(request, text, Object.freeze([]));
      }
      if (request.type === "worker.cancel.request") {
        const execution = active.get(request.attemptId);
        const finish = () => {
          if (execution) {
            execution.resolve(createWorkerControlResponseV1(execution.request, {
              type: "worker.execute.cancelled", payload: { reason: "cooperative_cancellation" },
            }));
          }
          return createWorkerControlResponseV1(request, { type: "worker.cancel.accepted", payload: { attemptId: request.attemptId } });
        };
        if (execution) {
          clearTimeout(execution.timer);
          active.delete(request.attemptId);
        }
        return hasAttemptTransfers(request.attemptId)
          ? discardAttempt(request.attemptId).then(finish) : finish();
      }
      prepared = false;
      const unloaded = () => createWorkerControlResponseV1(request, {
        type: "worker.unload.succeeded", payload: { unloaded: true },
      });
      return transfers.size ? Promise.all([...transfers.keys()].map(discard)).then(unloaded) : unloaded();
    },
    ready() { return prepared; },
  });
}
