ARG PLATFORM_PARENT
FROM ${PLATFORM_PARENT}
COPY --chown=1000:1000 apps/platform-api/src/casting/casting-session-service.mjs /opt/teamaibox/apps/platform-api/src/casting/casting-session-service.mjs
COPY --chown=1000:1000 generated/plugin-runtime.json /opt/teamaibox/config/plugin-runtime.json
COPY --chown=1000:1000 generated/plugin-source-catalog.json /opt/teamaibox/config/plugin-source-catalog.json
