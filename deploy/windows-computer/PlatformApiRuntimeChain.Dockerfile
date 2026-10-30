ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY --chown=1000:1000 apps/platform-api/src/virtual-computers/computer-composition.mjs /opt/teamaibox/apps/platform-api/src/virtual-computers/computer-composition.mjs
COPY --chown=1000:1000 apps/platform-api/src/virtual-computers/lifecycle.mjs /opt/teamaibox/apps/platform-api/src/virtual-computers/lifecycle.mjs
COPY --chown=1000:1000 services/scheduler/src/postgres-computer-capacity.mjs /opt/teamaibox/services/scheduler/src/postgres-computer-capacity.mjs
