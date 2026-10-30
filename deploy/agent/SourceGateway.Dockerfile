ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE}

WORKDIR /opt/teamaibox
COPY --chown=65532:65532 packages/observability ./packages/observability
COPY --chown=65532:65532 services/object-service/src/buffered-media-budget.mjs ./services/object-service/src/buffered-media-budget.mjs
COPY --chown=65532:65532 services/source-gateway ./services/source-gateway
COPY --chown=65532:65532 deploy/agent/package-source-gateway-main.mjs ./validation/package-source-gateway-main.mjs

USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=4s --start-period=5s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/validation/package-source-gateway-main.mjs"]
