ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE}

ARG IMAGE_REVISION=unknown
ARG IMAGE_VERSION=0.1.0
ARG SOURCE_DATE_EPOCH=0

LABEL org.opencontainers.image.title="Team AI Box Agent Compute Gateway" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="https://github.com/teamaibox/teamaibox" \
      com.teamaibox.architecture="linux/arm64/v8" \
      com.teamaibox.container-first="true"

WORKDIR /opt/teamaibox
COPY --chown=1000:1000 packages/observability ./packages/observability
COPY --chown=1000:1000 services/object-service/src/buffered-media-budget.mjs ./services/object-service/src/buffered-media-budget.mjs
COPY --chown=1000:1000 services/compute-gateway ./services/compute-gateway
COPY --chown=1000:1000 deploy/compose/agent-model-aliases.v1.json /run/config/agent-model-aliases.json

ENV NODE_ENV=production \
    AGENT_COMPUTE_GATEWAY_HOST=0.0.0.0 \
    AGENT_COMPUTE_GATEWAY_PORT=8080

USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/services/compute-gateway/server/main.mjs"]
