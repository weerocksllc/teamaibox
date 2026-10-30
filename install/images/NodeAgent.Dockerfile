ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.revision=${SOURCE_COMMIT} com.teamaibox.offline-installer-runtime="1"
COPY --chmod=0555 node-agent /usr/local/bin/teamaibox-node-agent
