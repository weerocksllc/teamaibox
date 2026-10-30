# Complete source build; no installed receiver image or development build cache.
ARG UBUNTU_IMAGE=docker.io/library/ubuntu@sha256:95fa486768020359141f1318720f43e7982ef926c792891d984aef9aaf05e7ea
FROM docker.io/library/rust@sha256:271849e998ffce5776454bbf98c5dc21baafc854ff8e566197908d3aca9a81e8 AS rust
FROM ${UBUNTU_IMAGE} AS native
RUN apt-get -o Acquire::Retries=2 update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake curl git pkg-config protobuf-compiler \
    libavahi-compat-libdnssd-dev libgstreamer-plugins-base1.0-dev libgstreamer-plugins-bad1.0-dev \
    libgstreamer1.0-dev libplist-dev libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl --fail --location --retry 2 --max-time 300 \
    https://codeload.github.com/FDH2/UxPlay/tar.gz/21eef8df25d91e12635c36d8176ad192725baca2 -o uxplay.tar.gz \
 && echo '03a92523cf750af87be594974819cd6709c5e7a6f8863f109b418b246acf9c5c  uxplay.tar.gz' | sha256sum -c - \
 && mkdir uxplay && tar xzf uxplay.tar.gz --strip-components=1 -C uxplay
COPY deploy/casting/uxplay-*.patch /build/patches/
COPY services/trusted_media_service/native/ /build/native/
RUN for name in session-pin pairing-boundary ephemeral-identity pairing-budget paired-peer platform-pairing-ack setup-secret video-geometry source-lifecycle; do \
      patch --batch --fuzz=0 -d uxplay -p1 < patches/uxplay-$name.patch || exit 1; done \
 && cp native/session_pin.h uxplay/teamaibox_session_pin.h \
 && for name in pairing_budget paired_peer platform_pairing_ack setup_secret; do cp native/$name.h uxplay/lib/teamaibox_$name.h; done \
 && cmake -S uxplay -B out -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-DTEAMAIBOX_PIN_STDIN \
    -DCMAKE_C_FLAGS=-DTEAMAIBOX_PIN_STDIN -DNO_MARCH_NATIVE=ON -DNO_X11_DEPS=ON -DCMAKE_INSTALL_PREFIX=/usr \
 && cmake --build out --parallel 2

FROM native AS webrtc
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH CARGO_NET_GIT_FETCH_WITH_CLI=true
WORKDIR /build/gst-rs
RUN curl --fail --location --retry 2 --max-time 300 \
    https://codeload.github.com/GStreamer/gst-plugins-rs/tar.gz/75e46c3a1b868e9a08fd688d091476b76a498df1 -o source.tar.gz \
 && echo 'b526d77a9f1af250988da25dc582bca19303a215d52dfe8c1228da0887405345  source.tar.gz' | sha256sum -c - \
 && mkdir src && tar xzf source.tar.gz --strip-components=1 -C src
WORKDIR /build/gst-rs/src
COPY deploy/casting/gst-webrtc-dynamic-geometry.patch /dynamic.patch
COPY deploy/casting/gst-webrtc-startup-geometry.patch /startup.patch
RUN echo '78a29692305fa131cef236d5c22e061894f6cbc43f408d36df7bb2537cc10620  net/webrtc/src/webrtcsink/imp.rs' | sha256sum -c - \
 && echo 'ceea5a17b4497a14bbcc2bc3bc32015bda5307c6b33f7634c6d5679cdf0559ca  Cargo.lock' | sha256sum -c - \
 && patch --batch --fuzz=0 -p1 < /dynamic.patch && patch --batch --fuzz=0 -p1 < /startup.patch \
 && GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 \
    GIT_CONFIG_KEY_1=url.https://github.com/GStreamer/gstreamer-rs.insteadOf \
    GIT_CONFIG_VALUE_1=https://gitlab.freedesktop.org/gstreamer/gstreamer-rs \
    timeout --signal=TERM --kill-after=15s 2400 cargo build --release --locked --jobs 2 -p gst-plugin-webrtc --no-default-features --features livekit \
 && echo 'ceea5a17b4497a14bbcc2bc3bc32015bda5307c6b33f7634c6d5679cdf0559ca  Cargo.lock' | sha256sum -c -

FROM ${UBUNTU_IMAGE}
RUN apt-get -o Acquire::Retries=2 update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates dbus avahi-daemon python3-gi gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 \
    gstreamer1.0-libav gstreamer1.0-nice gstreamer1.0-plugins-bad gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-tools libavahi-compat-libdnssd1 libplist-2.0-4 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 65532 teamaibox \
 && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin teamaibox \
 && groupmod --non-unique --gid 65532 avahi \
 && usermod --non-unique --uid 65532 --gid 65532 avahi \
 && install -d -o 65532 -g 65532 -m 0700 /run/teamaibox
COPY --from=native /build/out/uxplay /usr/bin/uxplay
COPY --from=native /build/uxplay /usr/share/teamaibox/source/uxplay
COPY --from=webrtc /build/gst-rs/src/target/release/libgstrswebrtc.so /usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstrswebrtc.so
COPY --from=webrtc /build/gst-rs/src/LICENSE-MPL-2.0 /usr/share/doc/teamaibox-trusted-media/gst-plugins-rs-LICENSE-MPL-2.0
COPY --from=webrtc /build/gst-rs/src/Cargo.lock /usr/share/teamaibox/source/gst-plugins-rs/Cargo.lock
COPY deploy/casting/*.patch /usr/share/teamaibox/source/patches/
COPY deploy/casting/Public.Dockerfile /usr/share/teamaibox/source/build/Public.Dockerfile
COPY deploy/legal/airplay-compatible/NOTICE.v4.txt /usr/share/doc/teamaibox-trusted-media/NOTICE
COPY services/trusted_media_service /opt/teamaibox/services/trusted_media_service
COPY services/trusted_media_runtime /opt/teamaibox/services/trusted_media_runtime
ENV PYTHONPATH=/opt/teamaibox PYTHONDONTWRITEBYTECODE=1 GST_DEBUG=0 NVIDIA_VISIBLE_DEVICES=void NVIDIA_DRIVER_CAPABILITIES=""
USER 65532:65532
WORKDIR /nonexistent
# Check the actual receiver/discovery executables, not only linked libraries
# and the media plugin. A listening control API alone cannot admit casting.
RUN test -x /usr/bin/uxplay && test -x /usr/bin/dbus-daemon \
 && test -x /usr/bin/dbus-send && test -x /usr/sbin/avahi-daemon \
 && for element in livekitwebrtcsink webrtcbin nicesrc nicesink dtlssrtpenc dtlssrtpdec sctpenc sctpdec rtpbin; do \
      GST_REGISTRY=/tmp/gstreamer-build-registry.bin gst-inspect-1.0 "$element" >/dev/null || exit 1; \
    done
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/python3", "-m", "services.trusted_media_runtime.appliance"]
