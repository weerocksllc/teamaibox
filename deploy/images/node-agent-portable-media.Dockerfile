ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chmod=0555 teamaibox-portable-node-agent /usr/local/bin/teamaibox-node-agent
