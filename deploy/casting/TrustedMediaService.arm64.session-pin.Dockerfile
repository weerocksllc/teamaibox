# Uses Docker's bundled frontend; no additional Docker Hub frontend is needed.
ARG UBUNTU_ARM64=ubuntu@sha256:95fa486768020359141f1318720f43e7982ef926c792891d984aef9aaf05e7ea

FROM ${UBUNTU_ARM64} AS build
ARG UXPLAY_COMMIT=21eef8df25d91e12635c36d8176ad192725baca2
ARG UXPLAY_ARCHIVE_SHA256=03a92523cf750af87be594974819cd6709c5e7a6f8863f109b418b246acf9c5c
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential=12.10ubuntu1 \
      ca-certificates=20260601~24.04.1 \
      cmake=3.28.3-1build7 \
      curl=8.5.0-2ubuntu10.13 \
      libavahi-compat-libdnssd-dev=0.8-13ubuntu6.2 \
      libgstreamer-plugins-base1.0-dev=1.24.2-1ubuntu0.4 \
      libgstreamer1.0-dev=1.24.2-1ubuntu0.1 \
      libplist-dev=2.3.0-1~exp2build2 \
      libssl-dev=3.0.13-0ubuntu3.15 \
      pkg-config=1.8.1-2build1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl --silent --show-error --fail --location --retry 3 --max-time 180 --output uxplay.tar.gz \
      "https://github.com/FDH2/UxPlay/archive/${UXPLAY_COMMIT}.tar.gz" \
 && echo "${UXPLAY_ARCHIVE_SHA256}  uxplay.tar.gz" | sha256sum --check --strict \
 && mkdir src \
 && tar --extract --gzip --file uxplay.tar.gz --strip-components=1 --directory src
COPY deploy/casting/uxplay-session-pin.patch /build/session-pin.patch
COPY deploy/casting/uxplay-pairing-boundary.patch /build/pairing-boundary.patch
COPY deploy/casting/uxplay-ephemeral-identity.patch /build/ephemeral-identity.patch
COPY deploy/casting/uxplay-pairing-budget.patch /build/pairing-budget.patch
COPY deploy/casting/uxplay-paired-peer.patch /build/paired-peer.patch
COPY deploy/casting/uxplay-platform-pairing-ack.patch /build/platform-pairing-ack.patch
COPY deploy/casting/uxplay-setup-secret.patch /build/setup-secret.patch
COPY services/trusted_media_service/native/setup_secret.h /build/teamaibox_setup_secret.h
COPY services/trusted_media_service/native/session_pin.h /build/teamaibox_session_pin.h
COPY services/trusted_media_service/native/pairing_budget.h /build/teamaibox_pairing_budget.h
COPY services/trusted_media_service/native/paired_peer.h /build/teamaibox_paired_peer.h
COPY services/trusted_media_service/native/platform_pairing_ack.h /build/teamaibox_platform_pairing_ack.h
COPY services/trusted_media_service/native/platform_pairing_ack_test.c /build/platform_pairing_ack_test.c
COPY services/trusted_media_service/native/pairing_boundary_test.c /build/pairing_boundary_test.c
RUN patch --batch --fuzz=0 -d src -p1 < session-pin.patch \
 && patch --batch --fuzz=0 -d src -p1 < pairing-boundary.patch \
 && patch --batch --fuzz=0 -d src -p1 < ephemeral-identity.patch \
 && patch --batch --fuzz=0 -d src -p1 < pairing-budget.patch \
 && patch --batch --fuzz=0 -d src -p1 < paired-peer.patch \
 && patch --batch --fuzz=0 -d src -p1 < platform-pairing-ack.patch \
 && patch --batch --fuzz=0 -d src -p1 < setup-secret.patch \
 && cp teamaibox_setup_secret.h src/lib/teamaibox_setup_secret.h \
 && cp teamaibox_session_pin.h src/teamaibox_session_pin.h \
 && cp teamaibox_pairing_budget.h src/lib/teamaibox_pairing_budget.h \
 && cp teamaibox_paired_peer.h src/lib/teamaibox_paired_peer.h \
 && cp teamaibox_platform_pairing_ack.h src/lib/teamaibox_platform_pairing_ack.h \
 && cp teamaibox_platform_pairing_ack.h /build/platform_pairing_ack.h \
 && cc -Wall -Wextra -Werror platform_pairing_ack_test.c -o platform-pairing-ack-test \
 && ./platform-pairing-ack-test \
 && cmake -S src -B out \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CXX_FLAGS=-DTEAMAIBOX_PIN_STDIN \
      -DCMAKE_C_FLAGS=-DTEAMAIBOX_PIN_STDIN \
      -DNO_MARCH_NATIVE=ON \
      -DNO_X11_DEPS=ON \
      -DCMAKE_INSTALL_PREFIX=/usr \
 && cmake --build out --parallel "$(nproc)" \
 && cc -DTEAMAIBOX_PIN_STDIN -I src/lib pairing_boundary_test.c \
      out/lib/libairplay.a -lcrypto -lpthread -o pairing-boundary-test \
 && ./pairing-boundary-test \
 && DESTDIR=/staging cmake --install out

FROM ${UBUNTU_ARM64}
ARG UXPLAY_COMMIT=21eef8df25d91e12635c36d8176ad192725baca2
LABEL org.opencontainers.image.title="Team AI Box trusted media service" \
      org.opencontainers.image.description="AirPlay-compatible wireless casting receiver (not Apple-certified)" \
      org.opencontainers.image.source="https://github.com/FDH2/UxPlay" \
      org.opencontainers.image.revision="${UXPLAY_COMMIT}" \
      org.opencontainers.image.licenses="GPL-3.0-only"
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      dbus=1.14.10-4ubuntu4.1 \
      gstreamer1.0-libav=1.24.1-1build1 \
      gstreamer1.0-plugins-bad=1.24.2-1ubuntu4 \
      gstreamer1.0-plugins-base=1.24.2-1ubuntu0.4 \
      gstreamer1.0-plugins-good=1.24.2-1ubuntu1.5 \
      gstreamer1.0-tools=1.24.2-1ubuntu0.1 \
      libavahi-compat-libdnssd1=0.8-13ubuntu6.2 \
      libplist-2.0-4=2.3.0-1~exp2build2 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 65532 teamaibox \
 && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin teamaibox \
 && install -d -o 65532 -g 65532 -m 0700 /run/teamaibox
COPY --from=build /staging/usr/bin/uxplay /usr/bin/uxplay
COPY --from=build /staging/usr/share/doc/uxplay /usr/share/doc/uxplay
COPY deploy/casting/trusted-media-container/media-health /opt/teamaibox/bin/media-health
COPY deploy/casting/trusted-media-container/teamaibox-media-supervisor /opt/teamaibox/bin/teamaibox-media-supervisor
COPY deploy/legal/airplay-compatible/NOTICE.v2.txt /usr/share/doc/teamaibox-trusted-media/NOTICE
RUN chmod 0555 /usr/bin/uxplay /opt/teamaibox/bin/media-health /opt/teamaibox/bin/teamaibox-media-supervisor \
 && chmod -R a=rX /usr/share/doc/uxplay /usr/share/doc/teamaibox-trusted-media
USER 65532:65532
WORKDIR /nonexistent
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/opt/teamaibox/bin/media-health", "--ready"]
ENTRYPOINT ["/opt/teamaibox/bin/teamaibox-media-supervisor"]
