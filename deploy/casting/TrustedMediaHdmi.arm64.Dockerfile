# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Component successor: final deployment still requires the normal release gate.
FROM ${BUILD_PARENT_1}
USER 0:0
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      gstreamer1.0-alsa=1.24.2-1ubuntu0.4 \
 && rm -rf /var/lib/apt/lists/*
COPY services/trusted_media_service /opt/teamaibox/services/trusted_media_service
ENV PYTHONPATH=/opt/teamaibox PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
LABEL org.teamaibox.claim="development-hdmi-component-not-product-accepted"
