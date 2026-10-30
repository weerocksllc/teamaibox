# Build-time successor of an explicitly verified dependency image. No apt/npm.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.revision=${SOURCE_COMMIT} com.teamaibox.offline-installer-runtime="1"
COPY --chown=1000:1000 apps/platform-api/server /opt/teamaibox/apps/platform-api/server
COPY --chown=1000:1000 apps/platform-api/src /opt/teamaibox/apps/platform-api/src
COPY --chown=1000:1000 services/agent-bridge /opt/teamaibox/services/agent-bridge
COPY --chown=1000:1000 services/scheduler /opt/teamaibox/services/scheduler
COPY --chown=1000:1000 services/plugin-runtime /opt/teamaibox/services/plugin-runtime
COPY --chown=1000:1000 packages/persistence/src /opt/teamaibox/packages/persistence/src
