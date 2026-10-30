# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
COPY --chown=65532:65532 services/trusted_media_service/webrtc_media_output.py services/trusted_media_service/livekit_browser_sink.py services/trusted_media_service/receiver_supervisor.py /opt/teamaibox/services/trusted_media_service/
COPY --chown=65532:65532 services/trusted_media_runtime/main.py /opt/teamaibox/services/trusted_media_runtime/main.py
USER 65532:65532
