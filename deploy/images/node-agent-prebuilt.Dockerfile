ARG UBUNTU_IMAGE=docker.m.daocloud.io/library/ubuntu@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea
FROM ${UBUNTU_IMAGE}

ARG TARGETARCH
LABEL org.opencontainers.image.title="Team AI Box Node Agent"
LABEL org.opencontainers.image.description="Exclusive authenticated Docker/device boundary with truthful host telemetry"
LABEL com.teamaibox.architecture="linux/arm64/v8"

COPY --chmod=0555 node-agent /usr/local/bin/teamaibox-node-agent

USER 10001:10001
EXPOSE 9443
HEALTHCHECK --interval=10s --timeout=4s --start-period=5s --retries=6 \
  CMD ["/usr/local/bin/teamaibox-node-agent", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/teamaibox-node-agent"]
