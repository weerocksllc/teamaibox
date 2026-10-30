ARG DEBIAN_IMAGE=docker.io/library/debian@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
FROM docker.io/library/golang:1.26 AS certificates
FROM ${DEBIAN_IMAGE} AS runtime-base
COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources
RUN apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt -o APT::Update::Error-Mode=any -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt -o Acquire::Retries=2 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
       ca-certificates python3 qemu-system-arm qemu-system-gui qemu-utils qemu-efi-aarch64 swtpm swtpm-tools pulseaudio \
    && rm -rf /var/lib/apt/lists/*
FROM runtime-base AS qemu-builder
# Keep the ARM TPM/PPI capability of the original windows-arm64-ppi runtime.
# Distribution QEMU packages are not a substitute: older ARM TIS devices have
# no ppi property and abort before Windows firmware can start.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gnupg build-essential ninja-build meson pkg-config python3-venv \
    libglib2.0-dev libpixman-1-dev libslirp-dev libfdt-dev zlib1g-dev libpulse-dev \
    && rm -rf /var/lib/apt/lists/*
ARG QEMU_VERSION=11.1.1
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
    && ninja -j2 qemu-system-aarch64

FROM runtime-base
COPY --from=qemu-builder /build/qemu-system-aarch64 /usr/local/bin/qemu-system-aarch64
COPY --from=qemu-builder /src/pc-bios/vgabios-ramfb.bin /usr/share/qemu/vgabios-ramfb.bin
COPY --from=qemu-builder /qemu-source-sha256 /usr/local/share/qemu-source-sha256
COPY --from=qemu-builder /src/VERSION /usr/local/share/qemu-source-version
# Reject an incompatible final image at build time, before it reaches a guest.
RUN qemu-system-aarch64 -device tpm-tis-device,help | grep -E '^[[:space:]]+ppi=<'
RUN python3 -c "import subprocess; drivers=subprocess.check_output(['qemu-system-aarch64','-audiodev','help'], text=True); assert 'pa' in drivers.split(), 'QEMU PulseAudio backend is missing'"
COPY deploy/windows-arm64-ppi/probe_ppi.py /usr/local/bin/probe-ppi
COPY deploy/windows-computer/*.py /opt/teamaibox/
RUN cp /opt/teamaibox/runtime.py /opt/teamaibox/windows_runtime.py
ARG IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="https://github.com/weerocksllc/teamaibox"
USER 10001:10001
ENTRYPOINT ["python3", "/opt/teamaibox/windows_runtime.py"]
CMD ["serve"]
