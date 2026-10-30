ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE} AS build

ARG PNPM_VERSION=11.1.3
ARG NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000
WORKDIR /build

RUN npm install --global --ignore-scripts --no-audit --no-fund "pnpm@${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/authorization/package.json ./packages/authorization/package.json
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY packages/ui-system/package.json ./packages/ui-system/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @teamaibox/web...

COPY apps/web ./apps/web
COPY packages/authorization ./packages/authorization
COPY packages/plugin-sdk ./packages/plugin-sdk
COPY packages/ui-system ./packages/ui-system
RUN pnpm --filter @teamaibox/web build

FROM ${NODE_IMAGE}

ARG IMAGE_REVISION=unknown
ARG IMAGE_VERSION=0.1.0
ARG SOURCE_DATE_EPOCH=0

LABEL org.opencontainers.image.title="Team AI Box Web boundary" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="https://github.com/teamaibox/teamaibox" \
      com.teamaibox.architecture="linux/arm64/v8" \
      com.teamaibox.container-first="true"

WORKDIR /opt/teamaibox
COPY --from=build --chown=1000:1000 /build/apps/web/dist ./web
COPY --chown=1000:1000 apps/web/server/web-boundary.mjs ./server/web-boundary.mjs

ENV NODE_ENV=production \
    WEB_HOST=0.0.0.0 \
    WEB_MODE=release \
    WEB_PORT=8443 \
    WEB_STATIC_ROOT=/opt/teamaibox/web

USER 1000:1000
EXPOSE 8080 8443
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "const https=require('node:https');const tls=process.env.WEB_TLS_CERT_FILE;const p=process.env.WEB_PORT||(tls?'8443':'8080');const r=(tls?https:require('node:http')).get({host:'127.0.0.1',port:p,path:'/health/ready',rejectUnauthorized:false},x=>process.exit(x.statusCode===200?0:1));r.setTimeout(2000,()=>r.destroy());r.on('error',()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/server/web-boundary.mjs"]
