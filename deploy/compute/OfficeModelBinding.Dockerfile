ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY apps/platform-api/src/compute/postgres-protected-local-attempt-repository.mjs /opt/teamaibox/apps/platform-api/src/compute/postgres-protected-local-attempt-repository.mjs
