function view(record, clientAnnotations) {
  return Object.freeze({
    schemaVersion: 1,
    artifactId: record.id,
    artifactKind: record.artifactKind,
    provenanceDigest: record.provenanceDigest,
    sourceArtifactIds: Object.freeze(record.sources.map((source) => source.provenanceId).filter(Boolean)),
    ...(Object.keys(clientAnnotations).length ? { clientAnnotations: Object.freeze(structuredClone(clientAnnotations)) } : {}),
  });
}

export class TeamDriveArtifactHandoff {
  #provenance;

  constructor({ provenanceService }) {
    if (!provenanceService?.consume || !provenanceService?.register) {
      throw new TypeError("Team Drive artifact handoff requires provenance service");
    }
    this.#provenance = provenanceService;
  }

  async ingest({ ownerIdentityId, referenceId, clientAnnotations = {} }) {
    const consumed = await this.#provenance.consume({
      context: { identityId: ownerIdentityId }, referenceId, audience: "team-drive.file",
      consumer: { kind: "team-drive", key: "team-drive.file-version", applicationKey: "official.team-drive" },
    });
    let record = consumed.provenance;
    if (record?.artifactKind !== "drive-file" || record.producer?.key !== "team-drive.file-version") {
      const registered = await this.#provenance.register({
        context: { identityId: ownerIdentityId }, referenceId, audience: "team-drive.file",
        artifactKind: "drive-file",
        producer: { kind: "team-drive", key: "team-drive.file-version", applicationKey: "official.team-drive" },
        sourceObjects: record ? [{ relationship: "export-of", object: record.object, provenanceId: record.id }] : [],
        metadata: { schemaVersion: 1, clientAnnotations },
      });
      record = registered.record;
    }
    return Object.freeze({ object: consumed.object, provenance: view(record, clientAnnotations) });
  }
}
