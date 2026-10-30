ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=0:0 phone-media-network.mjs node-agent-https-transport.mjs /opt/teamaibox/services/scheduler/src/
