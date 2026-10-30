ARG PLATFORM_PARENT
FROM ${PLATFORM_PARENT}
COPY --chown=1000:1000 generated/plugin-source-catalog.json /opt/teamaibox/config/plugin-source-catalog.json
COPY --chown=1000:1000 apps/platform-api/src/virtual-phones/ /opt/teamaibox/apps/platform-api/src/virtual-phones/
COPY --chown=1000:1000 apps/platform-api/server/platform-api.mjs /opt/teamaibox/apps/platform-api/server/platform-api.mjs
COPY --chown=1000:1000 apps/platform-api/test/ /opt/teamaibox/apps/platform-api/test/
COPY --chown=1000:1000 services/scheduler/src/ /opt/teamaibox/services/scheduler/src/
COPY --chown=1000:1000 services/scheduler/test/ /opt/teamaibox/services/scheduler/test/
RUN node --test /opt/teamaibox/apps/platform-api/test/virtual-phone-camera.test.mjs /opt/teamaibox/apps/platform-api/test/virtual-phone-camera-routes.test.mjs /opt/teamaibox/apps/platform-api/test/virtual-phone-http-api.test.mjs /opt/teamaibox/apps/platform-api/test/phone-browser-camera-sdp.test.mjs /opt/teamaibox/services/scheduler/test/android-phone-camera-command.test.mjs

