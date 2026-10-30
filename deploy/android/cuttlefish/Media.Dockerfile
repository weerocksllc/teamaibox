# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Preserve the qualified network/runtime bytes and alter only media discovery.
FROM ${BUILD_PARENT_1}
COPY phone_media_control.py /opt/teamaibox/
