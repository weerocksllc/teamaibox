ARG GO_IMAGE=docker.io/library/golang:1.26
ARG DEBIAN_IMAGE=docker.io/library/debian@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
FROM ${GO_IMAGE} AS build
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH=arm64
WORKDIR /source
COPY services/node-agent/ ./
RUN go build -trimpath -buildvcs=false -o /out/node-agent ./cmd/node-agent \
    && go build -trimpath -buildvcs=false -o /out/factory-worker-spec ./cmd/factory-worker-spec
FROM ${DEBIAN_IMAGE}
ARG IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="https://github.com/weerocksllc/teamaibox"
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build --chmod=0555 /out/node-agent /usr/local/bin/teamaibox-node-agent
COPY --from=build --chmod=0555 /out/factory-worker-spec /usr/local/bin/factory-worker-spec
USER 10001:10001
EXPOSE 9443
HEALTHCHECK --interval=10s --timeout=4s --start-period=5s --retries=6 CMD ["/usr/local/bin/teamaibox-node-agent", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/teamaibox-node-agent"]
