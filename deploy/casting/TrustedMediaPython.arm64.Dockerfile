# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Development-only Python/GStreamer process runtime. The invoker verifies the
# exact local native base image ID; no receiver is advertised by this build.
# base sha256:9d4420198d5c36f2bdd29e3ac28e5169058929f406e517e5f0680338127343f5
FROM ${BUILD_PARENT_1}
USER 0:0
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3-gi gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
USER 65532:65532
RUN python3 -I -c 'import gi; gi.require_version("Gst", "1.0"); from gi.repository import Gst; Gst.init(None); assert Gst.version()[0] == 1'
LABEL org.teamaibox.claim="development-component-not-product-accepted"
