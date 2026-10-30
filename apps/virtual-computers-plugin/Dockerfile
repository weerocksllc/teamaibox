ARG GUACAMOLE_IMAGE
ARG APPLICATION_BASE
FROM ${GUACAMOLE_IMAGE} AS desktop-assets
WORKDIR /tmp/computer-desktop-assets
RUN jar xf /opt/guacamole/webapp/guacamole.war guacamole-common-js/all.min.js META-INF/LICENSE META-INF/NOTICE

FROM ${APPLICATION_BASE}
# The static UI never installs packages at runtime. Node is self-contained for
# compression; remove the inherited package manager and its unused system zlib.
USER 0:0
RUN apk del --no-network apk-tools libapk zlib
ARG IMAGE_REVISION=unknown
LABEL org.opencontainers.image.title="Team AI Box Virtual Computers" \
      org.opencontainers.image.version="0.1.3" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      com.teamaibox.plugin.id="official.virtual-computers" \
      com.teamaibox.plugin.type="ApplicationPlugin"
WORKDIR /opt/teamaibox
COPY --chown=10001:10001 packages/plugin-sdk/ ./packages/plugin-sdk/
COPY --chown=10001:10001 packages/application-plugin-runtime/ ./packages/application-plugin-runtime/
COPY --chown=10001:10001 packages/ui-system/ ./packages/ui-system/
COPY --chown=10001:10001 apps/virtual-computers-plugin/src/ ./apps/virtual-computers-plugin/src/
COPY --chown=10001:10001 apps/virtual-computers-plugin/package.json ./apps/virtual-computers-plugin/package.json
COPY --from=desktop-assets --chown=10001:10001 /tmp/computer-desktop-assets/guacamole-common-js/all.min.js ./apps/virtual-computers-plugin/src/public/guacamole-common-js/all.min.js
COPY --from=desktop-assets --chown=10001:10001 /tmp/computer-desktop-assets/META-INF/LICENSE ./apps/virtual-computers-plugin/src/public/guacamole-common-js/LICENSE.txt
COPY --from=desktop-assets --chown=10001:10001 /tmp/computer-desktop-assets/META-INF/NOTICE ./apps/virtual-computers-plugin/src/public/guacamole-common-js/NOTICE.txt
ENV NODE_ENV=production PORT=8080
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/apps/virtual-computers-plugin/src/server.mjs"]
