# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
ARG BUILD_PARENT_2
FROM ${BUILD_PARENT_1} AS plugin
FROM ${BUILD_PARENT_2}
COPY --from=plugin --chmod=0555 /libgstrswebrtc.so /usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstrswebrtc.so
COPY --from=plugin /webrtcsink-imp.rs /usr/share/teamaibox/source/gst-plugins-rs/webrtcsink-imp.rs
COPY deploy/casting/gst-webrtc-startup-geometry.patch /usr/share/teamaibox/source/patches/
COPY deploy/casting/WebRtcStartupGeometry.arm64.Dockerfile /usr/share/teamaibox/source/build/
