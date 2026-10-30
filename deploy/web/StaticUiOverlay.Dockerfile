ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=10001:10001 overlay/ /opt/teamaibox/apps/
