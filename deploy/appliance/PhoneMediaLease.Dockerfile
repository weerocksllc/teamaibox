ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=1000:1000 services/scheduler/src/protected-node-agent-client.mjs /opt/teamaibox/services/scheduler/src/protected-node-agent-client.mjs
COPY --chown=1000:1000 apps/platform-api/src/virtual-phones/phone-access-service.mjs /opt/teamaibox/apps/platform-api/src/virtual-phones/phone-access-service.mjs
COPY --chown=1000:1000 apps/platform-api/src/virtual-phones/managed-node-phone-media-bridge.mjs /opt/teamaibox/apps/platform-api/src/virtual-phones/managed-node-phone-media-bridge.mjs

