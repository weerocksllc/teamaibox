ARG PARENT
FROM ${PARENT}
COPY --chmod=0555 teamaibox-node-agent /usr/local/bin/teamaibox-node-agent
