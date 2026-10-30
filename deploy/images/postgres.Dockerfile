ARG POSTGRES_IMAGE=docker.io/library/postgres@sha256:83b9631dbb4121d9235ef910018272798b7d3041ef5b716aa481122d4c49353f
FROM ${POSTGRES_IMAGE}

ARG IMAGE_REVISION=unknown
ARG IMAGE_VERSION=0.1.0
ARG MIGRATION_MANIFEST_SHA256=f90651348853df44ebd3f32cd59e688c5cdfa698a3c2758a2287950d0b8a20a3
LABEL org.opencontainers.image.title="Team AI Box PostgreSQL" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="https://github.com/teamaibox/teamaibox" \
      com.teamaibox.architecture="linux/arm64/v8" \
      com.teamaibox.container-first="true" \
      com.teamaibox.production-service="postgres"

COPY --chown=999:999 packages/persistence/migrations /opt/teamaibox/migrations
COPY --chown=999:999 --chmod=0555 deploy/runtime/apply-migrations.sh /usr/local/bin/teamaibox-apply-migrations

ENV TEAMAIBOX_MIGRATION_MANIFEST_SHA256=${MIGRATION_MANIFEST_SHA256}

USER 999:999
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=10 \
  CMD ["pg_isready", "-U", "teamaibox", "-d", "teamaibox"]
