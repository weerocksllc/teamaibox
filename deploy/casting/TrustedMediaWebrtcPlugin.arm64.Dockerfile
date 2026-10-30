# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
ARG BUILD_PARENT_2
# Development candidate only: the receiver/supervisor and real SFU/output
# acceptance must still be completed before any appliance advertisement.
FROM rust@sha256:271849e998ffce5776454bbf98c5dc21baafc854ff8e566197908d3aca9a81e8 AS rust
# Local-only build inputs. The build invoker must verify their exact image IDs
# before and after build; they are not public Docker Hub repositories.
# source: sha256:01cc8fad73f2270be5722c2cdc100318027ef3ccd949e3d9d5bd8ef2fc4d310a
FROM ${BUILD_PARENT_1} AS prepared
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libgstreamer-plugins-bad1.0-dev=1.24.2-1ubuntu4 \
      protobuf-compiler \
 && rm -rf /var/lib/apt/lists/*
ARG GST_RS_COMMIT=75e46c3a1b868e9a08fd688d091476b76a498df1
ARG GST_RS_ARCHIVE_SHA256=b526d77a9f1af250988da25dc582bca19303a215d52dfe8c1228da0887405345
WORKDIR /build/gst-rs
RUN curl --fail --silent --show-error --location --retry 2 --max-time 180 \
      "https://codeload.github.com/GStreamer/gst-plugins-rs/tar.gz/${GST_RS_COMMIT}" -o source.tar.gz \
 && echo "${GST_RS_ARCHIVE_SHA256}  source.tar.gz" | sha256sum --check --strict \
 && mkdir src && tar --extract --gzip --file source.tar.gz --strip-components=1 --directory src
WORKDIR /build/gst-rs/src
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
# Only LiveKit signalling, not the default Janus/WHIP/WHEP/web server feature
# set. Cargo.lock remains unchanged; no cargo update or unlocked fallback.
# Cargo's normal full-history fetch repeatedly lost the pack transfer. Seed
# only the exact lockfile commit from GStreamer's official GitHub mirror.
# Cargo still validates/resolves that original locked Git source identity.
RUN mkdir -p /usr/local/cargo/git/db/gstreamer-rs-66ec26b38a5f7ca5 \
 && git init --bare -q /usr/local/cargo/git/db/gstreamer-rs-66ec26b38a5f7ca5 \
 && timeout 90 git -c http.version=HTTP/1.1 -C /usr/local/cargo/git/db/gstreamer-rs-66ec26b38a5f7ca5 \
      fetch --depth=1 https://github.com/GStreamer/gstreamer-rs 4e20c0caa0100421080f081065e51f9341ba4693 \
 && test "$(git -C /usr/local/cargo/git/db/gstreamer-rs-66ec26b38a5f7ca5 rev-parse FETCH_HEAD)" = 4e20c0caa0100421080f081065e51f9341ba4693
RUN mkdir -p /usr/local/cargo/git/db/gtk-rs-core-35cb1a5a363f4187 \
 && git init --bare -q /usr/local/cargo/git/db/gtk-rs-core-35cb1a5a363f4187 \
 && timeout 90 git -c http.version=HTTP/1.1 -C /usr/local/cargo/git/db/gtk-rs-core-35cb1a5a363f4187 \
      fetch --depth=1 https://github.com/gtk-rs/gtk-rs-core ae5dabb51cedf4f32021ba861cdd69f6c5e60193 \
 && test "$(git -C /usr/local/cargo/git/db/gtk-rs-core-35cb1a5a363f4187 rev-parse FETCH_HEAD)" = ae5dabb51cedf4f32021ba861cdd69f6c5e60193
# Cargo resolves the workspace lock, including Git dependencies of other
# members. Cache their exact locked commits too, without building extra members
# or changing the lockfile, selected package, or enabled feature set.
RUN mkdir -p /usr/local/cargo/git/db/gtk4-rs-ff2bc21858344a74 \
 && git init --bare -q /usr/local/cargo/git/db/gtk4-rs-ff2bc21858344a74 \
 && timeout --signal=TERM --kill-after=15s 900 git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=60 -C /usr/local/cargo/git/db/gtk4-rs-ff2bc21858344a74 \
      fetch --progress --depth=1 https://github.com/gtk-rs/gtk4-rs 6e427d7afd0e2ba0248736c3907761506887fbeb \
 && test "$(git -C /usr/local/cargo/git/db/gtk4-rs-ff2bc21858344a74 rev-parse FETCH_HEAD)" = 6e427d7afd0e2ba0248736c3907761506887fbeb
RUN mkdir -p /usr/local/cargo/git/db/flavors-381b93703661a2ba \
 && git init --bare -q /usr/local/cargo/git/db/flavors-381b93703661a2ba \
 && timeout --signal=TERM --kill-after=15s 600 git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=60 -C /usr/local/cargo/git/db/flavors-381b93703661a2ba \
      fetch --progress --depth=1 https://github.com/rust-av/flavors 833508af656d298c269f2397c8541a084264d992 \
 && test "$(git -C /usr/local/cargo/git/db/flavors-381b93703661a2ba rev-parse FETCH_HEAD)" = 833508af656d298c269f2397c8541a084264d992
# Exportable, exact source-only preparation stage: a network transfer failure
# can resume in a bounded CPU build without changing host routing.
FROM prepared AS build
RUN mkdir -p /usr/local/cargo/git/db/ffv1-eeba7dabbdb7ea56 \
 && git init --bare -q /usr/local/cargo/git/db/ffv1-eeba7dabbdb7ea56 \
 && timeout --signal=TERM --kill-after=15s 600 git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=60 -C /usr/local/cargo/git/db/ffv1-eeba7dabbdb7ea56 \
      fetch --progress --depth=1 https://github.com/rust-av/ffv1.git bd9eabfc14c9ad53c37b32279e276619f4390ab8 \
 && test "$(git -C /usr/local/cargo/git/db/ffv1-eeba7dabbdb7ea56 rev-parse FETCH_HEAD)" = bd9eabfc14c9ad53c37b32279e276619f4390ab8
# Scope the observed HTTP/2 transport workaround and transfer deadline to this
# build process. Never change host VPN, routing or system/global Git config.
RUN GIT_CONFIG_COUNT=4 \
    GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 \
    GIT_CONFIG_KEY_1=http.lowSpeedLimit GIT_CONFIG_VALUE_1=1024 \
    GIT_CONFIG_KEY_2=http.lowSpeedTime GIT_CONFIG_VALUE_2=60 \
    GIT_CONFIG_KEY_3=url.https://github.com/GStreamer/gstreamer-rs.insteadOf \
    GIT_CONFIG_VALUE_3=https://gitlab.freedesktop.org/gstreamer/gstreamer-rs \
    CARGO_NET_RETRY=0 \
    timeout --signal=TERM --kill-after=15s 1200s cargo build --release --locked --jobs 2 -p gst-plugin-webrtc --no-default-features --features livekit

# runtime: sha256:9d4420198d5c36f2bdd29e3ac28e5169058929f406e517e5f0680338127343f5
FROM ${BUILD_PARENT_2}
COPY --from=build /build/gst-rs/src/target/release/libgstrswebrtc.so /usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstrswebrtc.so
COPY --from=build /build/gst-rs/src/LICENSE-MPL-2.0 /usr/share/doc/teamaibox-trusted-media/gst-plugins-rs-LICENSE-MPL-2.0
LABEL org.teamaibox.gst-plugins-rs.revision="75e46c3a1b868e9a08fd688d091476b76a498df1" \
      org.teamaibox.gst-plugins-rs.archive-sha256="b526d77a9f1af250988da25dc582bca19303a215d52dfe8c1228da0887405345" \
      org.teamaibox.claim="development-component-not-product-accepted"
RUN GST_REGISTRY=/tmp/gstreamer-build-registry.bin gst-inspect-1.0 livekitwebrtcsink >/dev/null
