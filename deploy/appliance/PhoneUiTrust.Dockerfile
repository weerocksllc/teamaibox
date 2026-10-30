ARG PLATFORM_PARENT
FROM ${PLATFORM_PARENT}
# Adds public signing trust for only the virtual-phone plugin.
COPY --chown=1000:1000 generated/plugin-source-catalog.json /opt/teamaibox/config/plugin-source-catalog.json

