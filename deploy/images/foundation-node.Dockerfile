ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE}

ARG SOURCE_DATE_EPOCH=0
ARG IMAGE_REVISION=unknown
ARG IMAGE_VERSION=0.1.0

LABEL org.opencontainers.image.title="Team AI Box foundation Node runtime" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="https://github.com/teamaibox/teamaibox" \
      com.teamaibox.architecture="linux/arm64/v8" \
      com.teamaibox.foundation-stub="true"

WORKDIR /opt/teamaibox
COPY --chown=1000:1000 package.json ./package.json
COPY --chown=1000:1000 packages/configuration ./packages/configuration
COPY --chown=1000:1000 packages/contracts ./packages/contracts
COPY --chown=1000:1000 packages/observability ./packages/observability
COPY --chown=1000:1000 packages/secrets ./packages/secrets
COPY --chown=1000:1000 packages/service-runtime ./packages/service-runtime
COPY --chown=1000:1000 deploy/compose/foundation-service.mjs ./foundation-service.mjs

ENV NODE_ENV=production \
    SERVICE_NAME=platform-api \
    PORT=8080

USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/foundation-service.mjs"]
