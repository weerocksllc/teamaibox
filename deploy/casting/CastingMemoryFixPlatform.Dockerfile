# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Parent imported manifest 64e30399005469f22448665b066d124a49577ff1a887b935512cde6f9dd33545.
FROM ${BUILD_PARENT_1}
COPY services/scheduler/src/postgres-unified-memory-snapshot-provider.mjs services/scheduler/src/unified-memory-guard.mjs services/scheduler/src/cluster-metric-service.mjs /opt/teamaibox/services/scheduler/src/
USER 1000:1000
LABEL org.teamaibox.casting="protected-resident-metrics-integration"
