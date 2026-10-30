# LiveKit 1.13.10 with the minimum fixed Go runtime and x/net versions.
FROM golang:1.27.2-alpine3.24@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS builder

ENV GOTOOLCHAIN=local
WORKDIR /workspace
COPY livekit-v1.13.10.tar.gz /tmp/livekit.tar.gz
RUN echo "d1b93ced314b14654faceeb99627a79114b8ebe002bb5d620be4a185db83a4b2  /tmp/livekit.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/livekit.tar.gz --strip-components=1 -C /workspace
RUN go get golang.org/x/net@v0.60.0 \
 && go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GO111MODULE=on \
    go build -trimpath -buildvcs=false -o /livekit-server ./cmd/server

FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
COPY --from=builder /livekit-server /livekit-server
LABEL org.opencontainers.image.title="livekit" \
      org.opencontainers.image.version="v1.13.10-teamaibox-security.1" \
      org.opencontainers.image.source="https://github.com/livekit/livekit" \
      org.opencontainers.image.revision="e5655ac20267fa5005dccaf3f0e3bfc3ea688c07" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.teamaibox.security.go="1.27.2" \
      org.teamaibox.security.golang-x-net="0.60.0"
USER 65532:65532
ENTRYPOINT ["/livekit-server"]
