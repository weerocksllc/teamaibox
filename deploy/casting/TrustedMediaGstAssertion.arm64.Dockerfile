# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
COPY --chown=65532:65532 services/trusted_media_service/native_failure.py /opt/teamaibox/services/trusted_media_service/
USER 65532:65532
