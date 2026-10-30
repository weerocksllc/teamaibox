# Candidate only: adds upstream ARM physical-presence support without changing
# any running Windows guest, its firmware variables, disk or TPM state.
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS builder
USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gnupg build-essential ninja-build meson pkg-config python3-venv \
    libglib2.0-dev libpixman-1-dev libslirp-dev libfdt-dev zlib1g-dev libpulse-dev \
    && rm -rf /var/lib/apt/lists/*
ARG QEMU_VERSION=11.1.1
# GitHub git transport reset twice in a1. Use the officially signed release,
# validating its published release-manager fingerprint before compilation.
RUN curl -fL --retry 2 --connect-timeout 15 --max-time 600 \
      https://download.qemu.org/qemu-${QEMU_VERSION}.tar.xz -o /qemu.tar.xz \
    && curl -fL --retry 2 --max-time 60 \
      https://download.qemu.org/qemu-${QEMU_VERSION}.tar.xz.sig -o /qemu.tar.xz.sig \
    && curl -fL --retry 2 --max-time 60 \
      https://keys.openpgp.org/vks/v1/by-fingerprint/CEACC9E15534EBABB82D3FA03353C9CEF108B584 -o /release-key.asc \
    && gpg --batch --import /release-key.asc \
    && gpg --batch --with-colons --fingerprint CEACC9E15534EBABB82D3FA03353C9CEF108B584 | grep 'fpr:::::::::CEACC9E15534EBABB82D3FA03353C9CEF108B584:' \
    && gpg --batch --verify /qemu.tar.xz.sig /qemu.tar.xz \
    && sha256sum /qemu.tar.xz > /qemu-source-sha256 \
    && mkdir /src && tar -xJf /qemu.tar.xz -C /src --strip-components=1 \
    && test "$(cat /src/VERSION)" = "${QEMU_VERSION}"
RUN mkdir /build && cd /build && /src/configure \
    --prefix=/usr --target-list=aarch64-softmmu --without-default-features \
    --enable-kvm --enable-vnc --enable-slirp --enable-tpm --enable-pixman \
    --enable-fdt=system --enable-pa --disable-docs --disable-werror \
    && ninja -j2 qemu-system-aarch64 \
    && ./qemu-system-aarch64 -device tpm-tis-device,help | grep ppi
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/qemu-system-aarch64 /usr/local/bin/qemu-system-aarch64
COPY --from=builder /src/pc-bios/vgabios-ramfb.bin /usr/share/qemu/vgabios-ramfb.bin
COPY --from=builder /qemu-source-sha256 /usr/local/share/qemu-source-sha256
COPY --from=builder /src/VERSION /usr/local/share/qemu-source-version
COPY probe_ppi.py /usr/local/bin/probe-ppi
ENTRYPOINT ["python3", "/usr/local/bin/probe-ppi"]
