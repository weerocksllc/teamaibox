# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# The invoker verifies the exact assembled GDP/WebRTC component parent:
# sha256:41d96bcf8f3f688bad644e1726c11178a907952c5cd4935a44185c17ee7e2450
FROM ${BUILD_PARENT_1}
USER 0:0
# Match the exact libnice version already in the pinned Ubuntu runtime.
# webrtcbin alone is not enough: it requires these actual ICE transport
# elements. Installing them is container-only, with no host/network changes.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gstreamer1.0-nice=0.1.21-2build3 \
 && rm -rf /var/lib/apt/lists/*
USER 65532:65532
RUN GST_REGISTRY=/tmp/gst-ice-registry.bin gst-inspect-1.0 nicesrc >/dev/null \
 && GST_REGISTRY=/tmp/gst-ice-registry.bin gst-inspect-1.0 nicesink >/dev/null \
 && GST_REGISTRY=/tmp/gst-ice-registry.bin gst-inspect-1.0 livekitwebrtcsink >/dev/null
LABEL org.teamaibox.claim="development-component-not-product-accepted"
