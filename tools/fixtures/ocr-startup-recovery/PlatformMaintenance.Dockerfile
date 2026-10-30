ARG PARENT
FROM ${PARENT}
COPY apps/platform-api/server/protected-office-runtime-maintenance.mjs /opt/teamaibox/apps/platform-api/server/protected-office-runtime-maintenance.mjs
COPY apps/platform-api/server/protected-office-set-production-runtime-factory.mjs /opt/teamaibox/apps/platform-api/server/protected-office-set-production-runtime-factory.mjs
COPY apps/platform-api/server/protected-office-set-production-wiring.mjs /opt/teamaibox/apps/platform-api/server/protected-office-set-production-wiring.mjs
COPY apps/platform-api/server/protected-office-set-production-scenarios.mjs /opt/teamaibox/apps/platform-api/server/protected-office-set-production-scenarios.mjs
