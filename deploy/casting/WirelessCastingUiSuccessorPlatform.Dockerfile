ARG PLATFORM_PARENT
FROM ${PLATFORM_PARENT}
# Keep the enabled runtime and its isolation policy unchanged. Only append this
# exact UI release's scoped public verification key; runtime config is identical.
COPY --chown=1000:1000 apps/platform-api/src/casting/authenticated-signalling-gateway.mjs /opt/teamaibox/apps/platform-api/src/casting/authenticated-signalling-gateway.mjs
COPY --chown=1000:1000 generated/plugin-runtime.json /opt/teamaibox/config/plugin-runtime.json
COPY --chown=1000:1000 generated/plugin-source-catalog.json /opt/teamaibox/config/plugin-source-catalog.json
