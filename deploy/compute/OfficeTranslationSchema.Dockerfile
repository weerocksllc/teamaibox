ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY apps/platform-api/src/compute/openai-worker-execution-bridge.mjs /opt/teamaibox/apps/platform-api/src/compute/openai-worker-execution-bridge.mjs
