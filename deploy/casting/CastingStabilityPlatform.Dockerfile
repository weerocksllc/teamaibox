# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
COPY apps/platform-api/src/casting/casting-session-service.mjs /opt/teamaibox/apps/platform-api/src/casting/casting-session-service.mjs
