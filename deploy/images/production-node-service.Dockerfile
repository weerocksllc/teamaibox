ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE} AS dependencies

ARG PNPM_VERSION=11.1.3
ARG NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000
WORKDIR /build
RUN npm install --global --ignore-scripts --no-audit --no-fund "pnpm@${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/platform-api/package.json ./apps/platform-api/package.json
COPY packages/configuration/package.json ./packages/configuration/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/persistence/package.json ./packages/persistence/package.json
COPY packages/service-runtime/package.json ./packages/service-runtime/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @teamaibox/platform-api...

FROM ${NODE_IMAGE}

ARG IMAGE_REVISION=unknown
ARG IMAGE_VERSION=0.1.0
ARG SERVICE_NAME

LABEL org.opencontainers.image.title="Team AI Box ${SERVICE_NAME}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="https://github.com/teamaibox/teamaibox" \
      com.teamaibox.architecture="linux/arm64/v8" \
      com.teamaibox.container-first="true" \
      com.teamaibox.production-service="${SERVICE_NAME}"

WORKDIR /opt/teamaibox
COPY --from=dependencies --chown=1000:1000 /build/node_modules ./node_modules
COPY --from=dependencies --chown=1000:1000 /build/packages/persistence/node_modules ./packages/persistence/node_modules
COPY --chown=1000:1000 packages/authorization ./packages/authorization
COPY --chown=1000:1000 packages/configuration ./packages/configuration
COPY --chown=1000:1000 packages/observability ./packages/observability
COPY --chown=1000:1000 packages/persistence ./packages/persistence
COPY --chown=1000:1000 packages/service-runtime ./packages/service-runtime
COPY --chown=1000:1000 services/agent-bridge ./services/agent-bridge
COPY --chown=1000:1000 services/messaging ./services/messaging
COPY --chown=1000:1000 services/object-service ./services/object-service
COPY --chown=1000:1000 services/plugin-runtime ./services/plugin-runtime
COPY --chown=1000:1000 services/scheduler ./services/scheduler
COPY --chown=1000:1000 services/source-gateway ./services/source-gateway
COPY --chown=1000:1000 services/compute-gateway ./services/compute-gateway
COPY --chown=1000:1000 deploy/runtime ./deploy/runtime

ENV NODE_ENV=production \
    TEAMAIBOX_SERVICE_NAME=${SERVICE_NAME} \
    TEAMAIBOX_SERVICE_PORT=8080

USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/deploy/runtime/production-service.mjs"]
