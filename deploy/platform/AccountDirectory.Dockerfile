ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=65532:65532 identity-administration-http-api.mjs identity-administration-service.mjs postgres-repository.mjs memory-repository.mjs /opt/teamaibox/apps/platform-api/src/identity/
