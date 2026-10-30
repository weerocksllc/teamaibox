# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Parent manifest d207ef94b116e525711a402626983949536dc42c44857e93d9768f1aa721bd0b.
FROM ${BUILD_PARENT_1}
COPY apps/platform-api/src/casting/casting-session-service.mjs /opt/teamaibox/apps/platform-api/src/casting/
USER 1000:1000
LABEL org.teamaibox.casting="preserve-authorized-session-control-during-media-outage"
