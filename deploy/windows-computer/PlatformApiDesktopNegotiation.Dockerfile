ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY --chown=1000:1000 apps/platform-api/src/virtual-computers/managed-desktop-backend.mjs /opt/teamaibox/apps/platform-api/src/virtual-computers/managed-desktop-backend.mjs
