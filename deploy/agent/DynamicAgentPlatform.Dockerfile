ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=1000:1000 apps/platform-api/server/platform-api.mjs /opt/teamaibox/apps/platform-api/server/platform-api.mjs
COPY --chown=1000:1000 apps/platform-api/src/assistant/opencode-agent-runner.mjs apps/platform-api/src/assistant/dynamic-agent-routes.mjs /opt/teamaibox/apps/platform-api/src/assistant/
COPY --chown=1000:1000 services/agent-bridge/src/dynamic-sandbox-controller.mjs /opt/teamaibox/services/agent-bridge/src/
COPY --chown=1000:1000 services/agent-bridge/server/dynamic-sandbox-main.mjs /opt/teamaibox/services/agent-bridge/server/
