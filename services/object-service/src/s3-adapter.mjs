export class InternalS3Adapter {
  #objects;

  constructor({ objectService }) {
    if (!objectService) throw new TypeError("protected object service is required");
    this.#objects = objectService;
  }

  putObject({ context, bucket, key, body, contentType, checksumSha256 }) {
    return this.#objects.upload({
      context, namespaceKey: bucket, objectKey: key, content: body,
      contentType, expectedSha256: checksumSha256,
    });
  }

  createMultipartUpload({ context, bucket, key, contentType, expectedSize, checksumSha256 }) {
    return this.#objects.beginMultipart({
      context, namespaceKey: bucket, objectKey: key, contentType,
      expectedSize, expectedSha256: checksumSha256,
    });
  }

  uploadPart({ context, uploadId, partNumber, body, checksumSha256 }) {
    return this.#objects.uploadPart({ context, uploadId, partNumber, content: body, expectedSha256: checksumSha256 });
  }

  listParts({ context, uploadId }) {
    return this.#objects.listUploadParts({ context, uploadId });
  }

  completeMultipartUpload({ context, uploadId, parts }) {
    return this.#objects.completeMultipart({ context, uploadId, parts });
  }

  abortMultipartUpload({ context, uploadId }) {
    return this.#objects.abortMultipart({ context, uploadId });
  }

  getObject({ context, bucket, key, versionId, range }) {
    return this.#objects.download({ context, namespaceKey: bucket, objectKey: key, version: versionId, range });
  }

  headObject({ context, bucket, key, versionId }) {
    return this.#objects.head({ context, namespaceKey: bucket, objectKey: key, version: versionId });
  }

  listObjectsV2({ context, bucket, prefix, continuationToken, maxKeys }) {
    return this.#objects.list({
      context, namespaceKey: bucket, prefix,
      cursor: continuationToken, limit: maxKeys,
    });
  }

  listObjectVersions({ context, bucket, key }) {
    return this.#objects.listVersions({ context, namespaceKey: bucket, objectKey: key });
  }

  deleteObject({ context, bucket, key }) {
    return this.#objects.delete({ context, namespaceKey: bucket, objectKey: key });
  }
}
