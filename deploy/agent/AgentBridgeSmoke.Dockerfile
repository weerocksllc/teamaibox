ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE}

WORKDIR /opt/teamaibox
COPY --chown=65532:65532 packages/observability ./packages/observability
COPY --chown=65532:65532 services/agent-bridge ./services/agent-bridge
COPY --chown=65532:65532 services/object-service/src/buffered-media-budget.mjs ./services/object-service/src/buffered-media-budget.mjs
COPY --chown=65532:65532 services/compute-gateway ./services/compute-gateway
COPY --chown=65532:65532 deploy/agent/opencode-real-smoke.mjs ./validation/opencode-real-smoke.mjs
COPY --chown=65532:65532 deploy/agent/opencode-bridge-main.mjs ./validation/opencode-bridge-main.mjs
COPY --chown=65532:65532 deploy/agent/opencode-bridge-real-smoke.mjs ./validation/opencode-bridge-real-smoke.mjs
COPY --chown=0:0 deploy/agent/opencode-prompt-init.mjs ./validation/opencode-prompt-init.mjs
COPY --chown=65532:65532 deploy/agent/opencode-model-fixture.mjs ./validation/opencode-model-fixture.mjs
COPY --chown=65532:65532 deploy/agent/opencode-prompt-real-smoke.mjs ./validation/opencode-prompt-real-smoke.mjs
COPY --chown=65532:65532 deploy/agent/opencode-prompt-recover-smoke.mjs ./validation/opencode-prompt-recover-smoke.mjs
COPY --chown=0:0 deploy/agent/opencode-queue-init.mjs ./validation/opencode-queue-init.mjs
COPY --chown=65532:65532 deploy/agent/opencode-queue-real-smoke.mjs ./validation/opencode-queue-real-smoke.mjs
COPY --chown=65532:65532 deploy/agent/assistant-agent-protocol-smoke.mjs ./validation/assistant-agent-protocol-smoke.mjs
COPY --chown=65532:65532 deploy/agent/assistant-agent-retained-smoke.mjs ./validation/assistant-agent-retained-smoke.mjs
COPY --chown=0:0 deploy/agent/opencode-real-init.mjs ./validation/opencode-real-init.mjs

USER 65532:65532
ENTRYPOINT ["node", "/opt/teamaibox/validation/opencode-real-smoke.mjs"]
