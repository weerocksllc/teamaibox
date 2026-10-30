ARG NODE_IMAGE=docker.io/library/node@sha256:d3724e44ee368606d753e0027eb8d2a94fc1f275e5d9e4620178a12edb655f5f
FROM ${NODE_IMAGE}
COPY apps/wireless-casting-plugin/vendor/alpine/libcrypto3-3.5.8-r0.apk /tmp/ui-libcrypto3.apk
COPY apps/wireless-casting-plugin/vendor/alpine/libssl3-3.5.8-r0.apk /tmp/ui-libssl3.apk
RUN apk add --no-cache --no-network /tmp/ui-libcrypto3.apk /tmp/ui-libssl3.apk \
    && rm /tmp/ui-libcrypto3.apk /tmp/ui-libssl3.apk
# Static server uses Node built-ins only; omit unused package managers.
RUN rm -r /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ARG IMAGE_REVISION=unknown
LABEL org.opencontainers.image.title="Team AI Box Virtual Phones" \
      org.opencontainers.image.version="0.1.15" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      com.teamaibox.plugin.id="official.virtual-phones" \
      com.teamaibox.plugin.type="ApplicationPlugin"
WORKDIR /opt/teamaibox
COPY --chown=10001:10001 packages/plugin-sdk/ ./packages/plugin-sdk/
COPY --chown=10001:10001 packages/application-plugin-runtime/ ./packages/application-plugin-runtime/
COPY --chown=10001:10001 packages/ui-system/ ./packages/ui-system/
COPY --chown=10001:10001 apps/virtual-phones-plugin/ ./apps/virtual-phones-plugin/
ENV NODE_ENV=production PORT=8080
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/apps/virtual-phones-plugin/src/server.mjs"]
