FROM scratch

ARG IMAGE_REVISION=unbuilt
ARG IMAGE_VERSION=0.0.0-source-scaffold
ARG ROOTFS_MANIFEST_SHA256=missing

LABEL org.opencontainers.image.title="Team AI Box AirPlay-compatible trusted media service" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      com.teamaibox.architecture="linux/arm64/v8" \
      com.teamaibox.boundary="trusted-media-service" \
      com.teamaibox.rootfs-manifest="${ROOTFS_MANIFEST_SHA256}"

# The build context itself is the controlled `trusted-media-service-rootfs/`
# directory. It is intentionally absent from source control and may be created
# only after the release gate verifies source mirrors, the complete license/SBOM
# closure, signatures, provenance, vulnerabilities and a second reproducible
# ARM64 build. Keeping the context at the rootfs boundary also prevents unrelated
# repository files from entering the image. A source checkout therefore cannot
# build a runnable receiver accidentally.
# Files stay root-owned and immutable; only the process identity is non-root.
COPY ./ /

USER 65532:65532
HEALTHCHECK --interval=5s --timeout=2s --start-period=30s --retries=6 \
  CMD ["/opt/teamaibox/bin/media-health", "--ready"]
ENTRYPOINT ["/opt/teamaibox/bin/teamaibox-media-supervisor"]
