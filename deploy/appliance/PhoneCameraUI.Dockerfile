ARG PLATFORM_PARENT
FROM ${PLATFORM_PARENT}
COPY --chown=1000:1000 generated/plugin-source-catalog.json /opt/teamaibox/config/plugin-source-catalog.json
COPY --chown=1000:1000 apps/platform-api/src/virtual-phones/ /opt/teamaibox/apps/platform-api/src/virtual-phones/
COPY --chown=1000:1000 apps/platform-api/test/ /opt/teamaibox/apps/platform-api/test/
RUN node --test /opt/teamaibox/apps/platform-api/test/virtual-phone-camera.test.mjs /opt/teamaibox/apps/platform-api/test/virtual-phone-http-api.test.mjs /opt/teamaibox/apps/platform-api/test/virtual-phone-capacity-composition.test.mjs

