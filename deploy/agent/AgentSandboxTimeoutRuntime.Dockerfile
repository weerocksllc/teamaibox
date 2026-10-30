ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY --chown=65532:65532 deploy/agent/opencode-bridge-main.mjs /opt/teamaibox/validation/opencode-bridge-main.mjs
