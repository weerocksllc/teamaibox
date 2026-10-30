import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[\x20-\x7e]+)?$/i;

function filename(objectKey, fallback) {
  const value = objectKey?.split("/").at(-1)?.trim();
  return (value || fallback).slice(0, 240);
}

function artifact(record, { label = null, role }) {
  return Object.freeze({
    referenceId: record.id,
    artifactId: record.id,
    objectId: record.object.objectId,
    objectVersion: record.object.objectVersion,
    label: (label?.trim() || filename(record.object.objectKey, "artifact")).slice(0, 240),
    mimeType: record.object.mediaType,
    sizeBytes: record.object.size,
    sha256: record.object.sha256,
    provenanceDigest: record.provenanceDigest,
    role,
    downloadPath: `/api/v1/assistant/artifacts/${record.id}/download`,
  });
}

export class AssistantArtifactHandoff {
  #provenance;

  constructor({ provenanceService }) {
    if (!provenanceService?.register || !provenanceService?.consume || !provenanceService?.issue) {
      throw new TypeError("Assistant artifact handoff requires provenance service");
    }
    this.#provenance = provenanceService;
  }

  async resolveInputs({ ownerIdentityId, runId, referenceIds }) {
    if (!UUID.test(ownerIdentityId ?? "") || !UUID.test(runId ?? "") || !Array.isArray(referenceIds)
      || new Set(referenceIds).size !== referenceIds.length
      || referenceIds.some((value) => !UUID.test(value))) {
      throw new PlatformError("assistant_artifact_input_invalid", "Assistant input artifacts are invalid", { status: 400 });
    }
    const values = [];
    for (const referenceId of referenceIds) {
      const registered = await this.#provenance.register({
        context: { identityId: ownerIdentityId }, referenceId, audience: "assistant.input",
        artifactKind: "ai-input", producer: { kind: "user", key: "assistant.upload", applicationKey: "official.assistant" },
        metadata: { schemaVersion: 1, runId },
      });
      await this.#provenance.consume({
        context: { identityId: ownerIdentityId }, referenceId, audience: "assistant.input",
        consumer: { kind: "application", key: "assistant.conversation", applicationKey: "official.assistant", jobId: runId },
      });
      values.push(artifact(registered.record, { role: "input" }));
    }
    return Object.freeze(values);
  }

  async registerOutput({ ownerIdentityId, runId, referenceId, label, mimeType, sizeBytes, inputArtifacts = [] }) {
    if (!UUID.test(ownerIdentityId ?? "") || !UUID.test(runId ?? "") || !UUID.test(referenceId ?? "")
      || typeof label !== "string" || !label.trim() || !MIME.test(mimeType ?? "")
      || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !Array.isArray(inputArtifacts)) {
      throw new PlatformError("assistant_runner_invalid", "Assistant artifact is invalid", { status: 502 });
    }
    const registered = await this.#provenance.register({
      context: { identityId: ownerIdentityId }, referenceId, audience: "assistant.artifact",
      artifactKind: "agent-artifact",
      producer: { kind: "agent", key: "agent.opencode", applicationKey: "official.assistant", jobId: runId },
      sourceObjects: inputArtifacts.map((item) => ({
        relationship: "derived-from",
        object: { objectId: item.objectId, objectVersion: item.objectVersion, size: item.sizeBytes, mediaType: item.mimeType, sha256: item.sha256 },
        provenanceId: item.artifactId,
      })),
      metadata: { schemaVersion: 1, runId, label: label.trim() },
    });
    if (registered.record.object.mediaType !== mimeType || registered.record.object.size !== sizeBytes) {
      throw new PlatformError("assistant_runner_invalid", "Assistant artifact facts do not match the protected object", { status: 502 });
    }
    return artifact(registered.record, { label, role: "output" });
  }

  async issueDownload({ ownerIdentityId, artifactId }) {
    return this.#provenance.issue({
      context: { identityId: ownerIdentityId }, artifactId,
      audience: "assistant.artifact", expiresInSeconds: 300,
    });
  }
}
