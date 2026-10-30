# Build on the networked build machine; the resulting package installs offline.
# Official Debian ARM64 filesystem, not an exported developer container.
ARG DEBIAN_IMAGE=docker.io/library/debian@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
FROM ${DEBIAN_IMAGE}
# Debian's signed repository metadata authenticates this bootstrap, including CA certificates.
RUN apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
    ca-certificates dnsmasq-base file iproute2 iptables libcap2 libcurl4t64 \
    libdrm2 libegl1 libfdt1 libgl1 libglib2.0-0t64 liblzma5 libvulkan1 \
    libwayland-client0 libwayland-server0 libx11-6 libxext6 libxml2 libz3-4 \
    mesa-vulkan-drivers net-tools openssl procps python3 unzip \
    && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.source="https://github.com/weerocksllc/teamaibox" \
      org.opencontainers.image.title="Cuttlefish public build dependencies"
