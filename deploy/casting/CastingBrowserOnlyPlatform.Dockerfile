# Exact deployed Platform parent must be inspected before building. Its unrelated
# application, office-model, storage and identity configuration is preserved.
ARG PLATFORM_PARENT
FROM ${PLATFORM_PARENT}
COPY --chown=1000:1000 apps/platform-api/src/casting/casting-session-service.mjs apps/platform-api/src/casting/casting-http-api.mjs apps/platform-api/src/casting/runtime-casting-availability.mjs apps/platform-api/src/casting/file-disabled-casting-availability.mjs apps/platform-api/src/casting/session-casting-runtime.mjs apps/platform-api/src/casting/trusted-media-runtime-client.mjs /opt/teamaibox/apps/platform-api/src/casting/
COPY --chown=1000:1000 apps/platform-api/server/casting-session-runtime.mjs /opt/teamaibox/apps/platform-api/server/casting-session-runtime.mjs
# Plugin bytes/catalog digests are produced by the existing UI release packager,
# never hand-edited or marked accepted by this Dockerfile.
COPY --chown=1000:1000 generated/plugin-runtime.json /opt/teamaibox/config/plugin-runtime.json
COPY --chown=1000:1000 generated/plugin-source-catalog.json /opt/teamaibox/config/plugin-source-catalog.json
LABEL org.teamaibox.claim="browser-only-candidate-not-product-accepted"
