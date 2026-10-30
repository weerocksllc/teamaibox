# Retain the already installed ARM64 userland; only the Node Agent is updated.
FROM localhost:15000/teamaibox/node-agent@sha256:baeecbb1e95750c174ecece3c19f931ea7b962763760cbf48771272cb3c0bd87
COPY --chmod=0555 node-agent /usr/local/bin/teamaibox-node-agent
