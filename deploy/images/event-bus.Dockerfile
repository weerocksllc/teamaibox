ARG NATS_IMAGE=docker.io/library/nats@sha256:064222a09af7b194af6760d6089aa9ebd93fe7b8136ec2193ddb72dd78d8bd4c
FROM ${NATS_IMAGE}

ARG IMAGE_REVISION=unknown
ARG IMAGE_VERSION=0.1.0
LABEL org.opencontainers.image.title="Team AI Box durable event bus" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="https://github.com/teamaibox/teamaibox" \
      com.teamaibox.architecture="linux/arm64/v8" \
      com.teamaibox.container-first="true" \
      com.teamaibox.production-service="event-bus"

USER 65534:65534
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=10 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8222/healthz?js-enabled-only=true"]
