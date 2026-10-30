ARG PLATFORM_PARENT
FROM ${PLATFORM_PARENT}
# Public signing trust only. No receiver, gateway, scheduling or credentials change.
COPY --chown=1000:1000 generated/plugin-source-catalog.json /opt/teamaibox/config/plugin-source-catalog.json
