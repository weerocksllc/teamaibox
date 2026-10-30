# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Exact source/cache snapshot; no network or dependency changes.
# Invoker verifies sha256:efd16722fb37f88fc860c3931e02785d1ab569c4f341c143d5c58dd3df9e348a.
FROM ${BUILD_PARENT_1} AS build
WORKDIR /build/gst-rs/src
COPY deploy/casting/gst-webrtc-dynamic-geometry.patch /dynamic.patch
COPY deploy/casting/gst-webrtc-startup-geometry.patch /startup.patch
RUN echo "78a29692305fa131cef236d5c22e061894f6cbc43f408d36df7bb2537cc10620  net/webrtc/src/webrtcsink/imp.rs" | sha256sum --check --strict \
 && echo "ceea5a17b4497a14bbcc2bc3bc32015bda5307c6b33f7634c6d5679cdf0559ca  Cargo.lock" | sha256sum --check --strict \
 && patch --batch --fuzz=0 -p1 < /dynamic.patch \
 && patch --batch --fuzz=0 -p1 < /startup.patch \
 && cargo build --offline --release --locked --jobs 2 -p gst-plugin-webrtc --no-default-features --features livekit \
 && echo "ceea5a17b4497a14bbcc2bc3bc32015bda5307c6b33f7634c6d5679cdf0559ca  Cargo.lock" | sha256sum --check --strict
FROM scratch
COPY --from=build /build/gst-rs/src/target/release/libgstrswebrtc.so /libgstrswebrtc.so
COPY --from=build /build/gst-rs/src/net/webrtc/src/webrtcsink/imp.rs /webrtcsink-imp.rs
