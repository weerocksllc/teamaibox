ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=1000:1000 authenticated-media-admission.mjs /opt/teamaibox/apps/platform-api/src/casting/authenticated-media-admission.mjs
