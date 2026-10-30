ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=1000:1000 services/scheduler/src/phone-media-network.mjs /opt/teamaibox/services/scheduler/src/phone-media-network.mjs
COPY --chown=1000:1000 services/scheduler/src/node-agent-https-transport.mjs /opt/teamaibox/services/scheduler/src/node-agent-https-transport.mjs
RUN node --input-type=module -e "await import('/opt/teamaibox/services/scheduler/src/node-agent-https-transport.mjs'); await import('/opt/teamaibox/apps/platform-api/server/appliance-main.mjs')"

