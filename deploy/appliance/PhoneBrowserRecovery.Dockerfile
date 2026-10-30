ARG PLATFORM_PARENT
FROM ${PLATFORM_PARENT}
COPY --chown=1000:1000 generated/plugin-source-catalog.json /opt/teamaibox/config/plugin-source-catalog.json
COPY --chown=1000:1000 apps/platform-api/src/objects/object-http-api.mjs /opt/teamaibox/apps/platform-api/src/objects/object-http-api.mjs
COPY --chown=1000:1000 apps/platform-api/test/object-http-api.test.mjs /opt/teamaibox/apps/platform-api/test/object-http-api.test.mjs
RUN node --test /opt/teamaibox/apps/platform-api/test/object-http-api.test.mjs

