ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE} AS dependencies
ARG PNPM_VERSION=11.1.3
ARG NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000
WORKDIR /build
RUN npm install --global --ignore-scripts --no-audit --no-fund "pnpm@${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/messaging/package.json ./services/messaging/package.json
COPY packages/persistence/package.json ./packages/persistence/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @teamaibox/messaging...

FROM ${NODE_IMAGE}
WORKDIR /opt/teamaibox
COPY --from=dependencies --chown=10002:10002 /build/node_modules ./node_modules
COPY --from=dependencies --chown=10002:10002 /build/services/messaging/node_modules ./services/messaging/node_modules
COPY --from=dependencies --chown=10002:10002 /build/packages/persistence/node_modules ./packages/persistence/node_modules
COPY --chown=10002:10002 packages/observability ./packages/observability
COPY --chown=10002:10002 packages/persistence ./packages/persistence
COPY --chown=10002:10002 services/messaging ./services/messaging
ENV NODE_ENV=production TEAMAIBOX_MESSAGING_SERVICE_PORT=8080
USER 10002:10002
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=2s --start-period=3s --retries=20 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/services/messaging/src/server.mjs"]
