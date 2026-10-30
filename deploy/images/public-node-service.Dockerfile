# The orchestrator builds API_IMAGE from platform-api.Dockerfile in this tree.
ARG API_IMAGE
FROM ${API_IMAGE}
ARG SERVICE_NAME
ARG ENTRYPOINT_PATH=/opt/teamaibox/deploy/runtime/production-service.mjs
ENV TEAMAIBOX_SERVICE_NAME=${SERVICE_NAME} TEAMAIBOX_SERVICE_PORT=8080 NODE_ENV=production \
    TEAMAIBOX_NODE_ENTRYPOINT=${ENTRYPOINT_PATH}
COPY packages/service-runtime/ /opt/teamaibox/packages/service-runtime/
COPY packages/configuration/ /opt/teamaibox/packages/configuration/
COPY deploy/runtime/ /opt/teamaibox/deploy/runtime/
COPY --chmod=0555 deploy/runtime/public-node-entrypoint.sh /usr/local/bin/teamaibox-node-entrypoint
ENTRYPOINT ["/usr/local/bin/teamaibox-node-entrypoint"]
