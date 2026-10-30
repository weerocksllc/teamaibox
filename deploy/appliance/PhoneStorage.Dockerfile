ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=1000:1000 apps/platform-api/server/platform-api.mjs /opt/teamaibox/apps/platform-api/server/platform-api.mjs
COPY --chown=1000:1000 apps/platform-api/server/appliance-main.mjs /opt/teamaibox/apps/platform-api/server/appliance-main.mjs
COPY --chown=1000:1000 apps/platform-api/src/virtual-phones/phone-capacity-composition.mjs /opt/teamaibox/apps/platform-api/src/virtual-phones/phone-capacity-composition.mjs
COPY --chown=1000:1000 apps/platform-api/src/virtual-phones/managed-node-phone-runtime.mjs /opt/teamaibox/apps/platform-api/src/virtual-phones/managed-node-phone-runtime.mjs
COPY --chown=1000:1000 apps/platform-api/src/virtual-phones/managed-node-phone-files.mjs /opt/teamaibox/apps/platform-api/src/virtual-phones/managed-node-phone-files.mjs
COPY --chown=1000:1000 apps/platform-api/src/virtual-phones/managed-node-phone-media-bridge.mjs /opt/teamaibox/apps/platform-api/src/virtual-phones/managed-node-phone-media-bridge.mjs
COPY --chown=1000:1000 apps/platform-api/src/virtual-phones/postgres-phone-repository.mjs /opt/teamaibox/apps/platform-api/src/virtual-phones/postgres-phone-repository.mjs
COPY --chown=1000:1000 apps/platform-api/src/storage/managed-phone-storage-repository.mjs /opt/teamaibox/apps/platform-api/src/storage/managed-phone-storage-repository.mjs
COPY --chown=1000:1000 apps/platform-api/src/storage/storage-administration-service.mjs /opt/teamaibox/apps/platform-api/src/storage/storage-administration-service.mjs
COPY --chown=1000:1000 services/scheduler/src/phone-storage-observation.mjs /opt/teamaibox/services/scheduler/src/phone-storage-observation.mjs
COPY --chown=1000:1000 services/scheduler/src/postgres-phone-capacity.mjs /opt/teamaibox/services/scheduler/src/postgres-phone-capacity.mjs
COPY --chown=1000:1000 services/scheduler/src/managed-node-agent-router.mjs /opt/teamaibox/services/scheduler/src/managed-node-agent-router.mjs
COPY --chown=1000:1000 services/scheduler/src/protected-node-agent-client.mjs /opt/teamaibox/services/scheduler/src/protected-node-agent-client.mjs
RUN node --input-type=module -e "await import('/opt/teamaibox/apps/platform-api/server/appliance-main.mjs');await import('/opt/teamaibox/apps/platform-api/src/virtual-phones/phone-capacity-composition.mjs')"

