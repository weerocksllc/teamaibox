ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
ARG PYTHON_IMAGE=docker.io/library/python@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134
FROM ${NODE_IMAGE} AS dependencies

ARG PNPM_VERSION=11.1.3
# Allow high-latency publisher connections before trying another IP address.
# Build-stage ARG only: do not change the installed application's networking.
ARG NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000
WORKDIR /build

RUN npm install --global --ignore-scripts --no-audit --no-fund "pnpm@${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/platform-api/package.json ./apps/platform-api/package.json
COPY packages/persistence/package.json ./packages/persistence/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @teamaibox/platform-api...

FROM ${PYTHON_IMAGE} AS validator-runtime

FROM ${NODE_IMAGE}

ARG IMAGE_REVISION=unknown
ARG IMAGE_VERSION=0.1.0
ARG SOURCE_DATE_EPOCH=0

LABEL org.opencontainers.image.title="Team AI Box Platform API" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="https://github.com/teamaibox/teamaibox" \
      com.teamaibox.architecture="linux/arm64/v8" \
      com.teamaibox.container-first="true"

WORKDIR /opt/teamaibox
COPY --from=dependencies --chown=1000:1000 /build/node_modules ./node_modules
COPY --from=dependencies --chown=1000:1000 /build/apps/platform-api/node_modules ./apps/platform-api/node_modules
COPY --from=dependencies --chown=1000:1000 /build/packages/persistence/node_modules ./packages/persistence/node_modules
COPY --from=validator-runtime /usr/local/bin/python3 /usr/local/bin/python3
COPY --from=validator-runtime /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=validator-runtime /usr/local/lib/libpython3.12.so.1.0 /usr/local/lib/libpython3.12.so.1.0
COPY --from=validator-runtime /usr/local/lib/libpython3.12.so /usr/local/lib/libpython3.12.so
COPY --from=validator-runtime /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --chown=1000:1000 packages/authorization ./packages/authorization
COPY --chown=1000:1000 packages/ui-system ./packages/ui-system
COPY --chown=1000:1000 packages/observability ./packages/observability
COPY --chown=1000:1000 packages/secrets ./packages/secrets
COPY --chown=1000:1000 packages/persistence ./packages/persistence
COPY --chown=1000:1000 services/object-service ./services/object-service
COPY --chown=1000:1000 services/agent-bridge ./services/agent-bridge
COPY --chown=1000:1000 services/messaging ./services/messaging
COPY --chown=1000:1000 services/plugin-runtime ./services/plugin-runtime
COPY --chown=1000:1000 services/scheduler ./services/scheduler
COPY --chown=1000:1000 services/source-gateway ./services/source-gateway
COPY --chown=1000:1000 services/compute-gateway ./services/compute-gateway
COPY --chown=1000:1000 services/unlock-service ./services/unlock-service
COPY --chown=1000:1000 apps/platform-api ./apps/platform-api
COPY --chown=1000:1000 deploy/compose/agent-model-aliases.v1.json /run/config/agent-model-aliases.json
COPY --chown=1000:1000 deploy/plugins/import-policy.v1.json ./config/plugin-import-policy.json
COPY --chown=1000:1000 deploy/plugins/sandbox-policy.v1.json ./config/plugin-sandbox-policy.json
COPY --chown=1000:1000 deploy/applications/built-in-applications.v1.json ./config/built-in-applications.json
COPY --chown=1000:1000 deploy/casting/wireless-casting-control-plane.disabled.v1.json ./config/wireless-casting-control-plane.disabled.v1.json

ENV NODE_ENV=production \
    PLATFORM_API_HOST=0.0.0.0 \
    PLATFORM_API_PORT=8080

# Resolve the real appliance entry-point graph at build time. Importing this
# module does not start the service or require a database/installation secrets.
RUN node --input-type=module -e "await import('./apps/platform-api/server/appliance-main.mjs')"

USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/apps/platform-api/server/appliance-main.mjs"]
