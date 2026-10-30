ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=1000:1000 plugin-runtime.mjs /opt/teamaibox/apps/platform-api/server/plugin-runtime.mjs
