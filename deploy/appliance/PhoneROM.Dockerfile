ARG PLATFORM_PARENT
FROM ${PLATFORM_PARENT}
COPY --chown=1000:1000 generated/plugin-source-catalog.json /opt/teamaibox/config/plugin-source-catalog.json
COPY --chown=1000:1000 apps/platform-api/src/virtual-phones/ /opt/teamaibox/apps/platform-api/src/virtual-phones/
COPY --chown=1000:1000 apps/platform-api/server/appliance-main.mjs /opt/teamaibox/apps/platform-api/server/appliance-main.mjs
COPY --chown=1000:1000 services/scheduler/src/phone-rom.mjs services/scheduler/src/phone-approved-nodes.mjs services/scheduler/src/postgres-phone-capacity.mjs /opt/teamaibox/services/scheduler/src/
COPY --chown=1000:1000 packages/persistence/migrations/manifest.json /opt/teamaibox/packages/persistence/migrations/manifest.json
COPY --chown=1000:1000 apps/platform-api/test/virtual-phone-rom.test.mjs apps/platform-api/test/appliance-runtime.test.mjs /opt/teamaibox/apps/platform-api/test/
RUN node --test /opt/teamaibox/apps/platform-api/test/virtual-phone-rom.test.mjs /opt/teamaibox/apps/platform-api/test/appliance-runtime.test.mjs

