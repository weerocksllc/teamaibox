ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY --chown=1000:1000 deploy/compose/agent-model-aliases.v1.json /run/config/agent-model-aliases.json
