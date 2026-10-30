# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Exact imported parent manifest a28026828d3613bf524dac2bb5a4458299b0f44b6e300de817ce564dbf2722f6;
# remote parent image c69214a2d1b1b348fc04ad02a1edeedbc083c6fda09c7c0dc5ca9512b0f6b7bc.
FROM ${BUILD_PARENT_1}
COPY apps/platform-api/src/casting/postgres-casting-repository.mjs apps/platform-api/src/casting/trusted-media-runtime-client.mjs /opt/teamaibox/apps/platform-api/src/casting/
COPY services/scheduler/src/managed-node-scheduling.mjs /opt/teamaibox/services/scheduler/src/
USER 1000:1000
LABEL org.teamaibox.casting="private-resource-bound-browser-runtime-start-fix" \
      org.teamaibox.claim="development-not-apple-or-browser-accepted"
