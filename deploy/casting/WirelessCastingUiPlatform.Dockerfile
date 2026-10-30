ARG PLATFORM_PARENT
FROM ${PLATFORM_PARENT}
COPY --chown=1000:1000 apps/platform-api/src/casting/file-disabled-casting-availability.mjs /opt/teamaibox/apps/platform-api/src/casting/file-disabled-casting-availability.mjs
COPY --chown=1000:1000 deploy/casting/wireless-casting-control-plane.disabled.v2.json /opt/teamaibox/config/wireless-casting-control-plane.disabled.v2.json
COPY --chown=1000:1000 generated/plugin-runtime.json /opt/teamaibox/config/plugin-runtime.json
COPY --chown=1000:1000 generated/plugin-source-catalog.json /opt/teamaibox/config/plugin-source-catalog.json
ENV PLATFORM_CASTING_AVAILABILITY_FILE=/opt/teamaibox/config/wireless-casting-control-plane.disabled.v2.json
