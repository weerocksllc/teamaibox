# The lab builder supplies the exact cached ARM64 base image ID.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      qemu-system-arm qemu-utils qemu-efi-aarch64 swtpm swtpm-tools \
      python3 ca-certificates curl xorriso wimtools \
    && dpkg-query -W > /usr/local/share/windows-runtime-packages.txt \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends novnc websockify \
    && dpkg-query -W > /usr/local/share/windows-runtime-packages.txt \
    && rm -rf /var/lib/apt/lists/*
# No KVM/GPU/host mounts during build; runtime receives only explicitly owned devices/data.
COPY probe_runtime.py /usr/local/bin/probe-windows-runtime
ENTRYPOINT ["python3", "/usr/local/bin/probe-windows-runtime"]
