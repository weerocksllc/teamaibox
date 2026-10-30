# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
COPY services/trusted_media_service/gdp_media_ingress.py services/trusted_media_service/webrtc_media_output.py services/trusted_media_service/media_progress.py services/trusted_media_service/receiver_supervisor.py /opt/teamaibox/services/trusted_media_service/
