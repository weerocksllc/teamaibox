ARG NODE_IMAGE=docker.io/library/node@sha256:d3724e44ee368606d753e0027eb8d2a94fc1f275e5d9e4620178a12edb655f5f
FROM ${NODE_IMAGE}

COPY apps/wireless-casting-plugin/vendor/alpine/libcrypto3-3.5.9-r0.apk /tmp/ui-libcrypto3.apk
COPY apps/wireless-casting-plugin/vendor/alpine/libssl3-3.5.9-r0.apk /tmp/ui-libssl3.apk
COPY apps/wireless-casting-plugin/vendor/alpine/zlib-1.3.2-r1.apk /tmp/ui-zlib.apk
RUN apk add --no-cache --no-network /tmp/ui-libcrypto3.apk /tmp/ui-libssl3.apk /tmp/ui-zlib.apk \
    && rm /tmp/ui-libcrypto3.apk /tmp/ui-libssl3.apk /tmp/ui-zlib.apk

# The static UI uses Node built-ins only. Do not ship unused package managers.
RUN rm -r /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

ARG IMAGE_REVISION=unknown
ARG IMAGE_VERSION=0.1.9

LABEL org.opencontainers.image.title="Team AI Box Wireless Casting ApplicationPlugin" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="https://github.com/teamaibox/teamaibox" \
      com.teamaibox.plugin.id="official.wireless-casting" \
      com.teamaibox.plugin.type="ApplicationPlugin" \
      com.teamaibox.architecture="linux/arm64/v8"

WORKDIR /opt/teamaibox
COPY --chown=10001:10001 packages/plugin-sdk/ ./packages/plugin-sdk/
COPY --chown=10001:10001 packages/application-plugin-runtime/ ./packages/application-plugin-runtime/
COPY --chown=10001:10001 packages/ui-system/ ./packages/ui-system/
COPY --chown=10001:10001 apps/wireless-casting-plugin/package.json ./apps/wireless-casting-plugin/package.json
COPY --chown=10001:10001 apps/wireless-casting-plugin/src/ ./apps/wireless-casting-plugin/src/
RUN test -s apps/wireless-casting-plugin/src/public/vendor/livekit-client-2.21.0.esm.mjs \
    && test -s apps/wireless-casting-plugin/src/public/vendor/livekit-client-LICENSE.txt

ENV NODE_ENV=production PORT=8080
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/apps/wireless-casting-plugin/src/server.mjs"]
