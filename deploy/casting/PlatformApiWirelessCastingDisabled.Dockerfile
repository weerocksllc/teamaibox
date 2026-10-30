ARG BASE_IMAGE
FROM ${BASE_IMAGE}

USER root
COPY deploy/casting/apply-disabled-casting-platform-overlay.mjs /tmp/apply-disabled-casting-platform-overlay.mjs
COPY --chown=1000:1000 apps/platform-api/src/casting/casting-http-api.mjs /opt/teamaibox/apps/platform-api/src/casting/casting-http-api.mjs
COPY --chown=1000:1000 apps/platform-api/src/casting/file-disabled-casting-availability.mjs /opt/teamaibox/apps/platform-api/src/casting/file-disabled-casting-availability.mjs
COPY --chown=1000:1000 deploy/casting/wireless-casting-control-plane.disabled.v1.json /opt/teamaibox/config/wireless-casting-control-plane.disabled.v1.json
RUN node /tmp/apply-disabled-casting-platform-overlay.mjs /opt/teamaibox/apps/platform-api/server/platform-api.mjs \
    && rm /tmp/apply-disabled-casting-platform-overlay.mjs

ENV PLATFORM_CASTING_AVAILABILITY_FILE=/opt/teamaibox/config/wireless-casting-control-plane.disabled.v1.json
LABEL com.teamaibox.wireless-casting.mode="disabled" \
      com.teamaibox.wireless-casting.receiver-ready="false" \
      com.teamaibox.wireless-casting.product-accepted="false"

USER 1000:1000
