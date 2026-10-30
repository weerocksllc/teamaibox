ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
ARG GUACAMOLE_IMAGE
FROM ${GUACAMOLE_IMAGE} AS desktop-assets
WORKDIR /tmp/computer-desktop-assets
RUN jar xf /opt/guacamole/webapp/guacamole.war guacamole-common-js/all.min.js META-INF/LICENSE META-INF/NOTICE
FROM ${NODE_IMAGE}
WORKDIR /opt/teamaibox
COPY --chown=10001:10001 packages/plugin-sdk/ ./packages/plugin-sdk/
COPY --chown=10001:10001 packages/ui-system/ ./packages/ui-system/
COPY --chown=10001:10001 packages/application-plugin-runtime/ ./packages/application-plugin-runtime/
COPY --chown=10001:10001 apps/virtual-computers-plugin/ ./apps/virtual-computers-plugin/
COPY --from=desktop-assets --chown=10001:10001 /tmp/computer-desktop-assets/guacamole-common-js/all.min.js ./apps/virtual-computers-plugin/src/public/guacamole-common-js/all.min.js
COPY --from=desktop-assets --chown=10001:10001 /tmp/computer-desktop-assets/META-INF/LICENSE ./apps/virtual-computers-plugin/src/public/guacamole-common-js/LICENSE.txt
COPY --from=desktop-assets --chown=10001:10001 /tmp/computer-desktop-assets/META-INF/NOTICE ./apps/virtual-computers-plugin/src/public/guacamole-common-js/NOTICE.txt
ENV NODE_ENV=production PORT=8080
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=2s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/apps/virtual-computers-plugin/src/server.mjs"]

