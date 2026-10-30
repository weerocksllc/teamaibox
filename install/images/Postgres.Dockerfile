ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG SOURCE_COMMIT
ARG MIGRATION_DIGEST
LABEL org.opencontainers.image.revision=${SOURCE_COMMIT} com.teamaibox.offline-installer-runtime="1"
COPY --chown=999:999 packages/persistence/migrations /opt/teamaibox/migrations
COPY --chown=999:999 --chmod=0555 deploy/runtime/apply-migrations.sh /usr/local/bin/teamaibox-apply-migrations
ENV TEAMAIBOX_MIGRATION_MANIFEST_SHA256=${MIGRATION_DIGEST}
