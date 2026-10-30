ARG POSTGRES_IMAGE=docker.io/library/postgres@sha256:83b9631dbb4121d9235ef910018272798b7d3041ef5b716aa481122d4c49353f
FROM ${POSTGRES_IMAGE}
ARG IMAGE_REVISION=unknown
ARG MIGRATION_MANIFEST_SHA256=f90651348853df44ebd3f32cd59e688c5cdfa698a3c2758a2287950d0b8a20a3
COPY --chown=999:999 packages/persistence/migrations /opt/teamaibox/migrations
COPY --chown=999:999 --chmod=0555 deploy/runtime/apply-migrations.sh /usr/local/bin/teamaibox-apply-migrations
RUN test -n "${MIGRATION_MANIFEST_SHA256}" \
    && test "$(sha256sum /opt/teamaibox/migrations/manifest.json | cut -d ' ' -f 1)" = "${MIGRATION_MANIFEST_SHA256}"
ENV TEAMAIBOX_MIGRATION_MANIFEST_SHA256=${MIGRATION_MANIFEST_SHA256}
USER 999:999
ENTRYPOINT ["/usr/local/bin/teamaibox-apply-migrations"]
LABEL org.opencontainers.image.title="Team AI Box appliance database migration" \
      org.opencontainers.image.revision="${IMAGE_REVISION}"
