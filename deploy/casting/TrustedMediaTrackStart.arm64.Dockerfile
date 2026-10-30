# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
COPY services/trusted_media_service/webrtc_media_output.py /opt/teamaibox/services/trusted_media_service/webrtc_media_output.py
USER 65532:65532
