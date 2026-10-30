# Bounded invoker checks the exact existing ARM64 media image before building.
# Discovery belongs to the container, never the host system D-Bus or Avahi.
ARG MEDIA_PARENT=teamaibox/trusted-media-service:gdp-webrtc-ice-candidate-20260907-a1
FROM ${MEDIA_PARENT}
USER 0:0
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      avahi-daemon=0.8-13ubuntu6.2 avahi-utils=0.8-13ubuntu6.2 \
 && rm -rf /var/lib/apt/lists/* \
 && usermod --non-unique --uid 65532 --gid 65532 avahi \
 && groupmod --non-unique --gid 65532 avahi \
 && install -d -o 65532 -g 65532 -m 0700 /run/avahi-daemon
# The Avahi package requires its named account for its runtime-dir check.
# Both names resolve to the same unprivileged container-only uid/gid.
USER 65532:65532
LABEL org.teamaibox.claim="development-component-not-product-accepted" \
      org.teamaibox.discovery="private-unix-bus-no-host-dbus"
