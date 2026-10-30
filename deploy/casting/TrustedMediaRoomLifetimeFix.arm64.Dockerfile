ARG MEDIA_PARENT=teamaibox/trusted-media-service:lifetime-fix-20260908-a1
FROM ${MEDIA_PARENT}
COPY --chown=65532:65532 services/trusted_media_service/livekit_room_control.py services/trusted_media_service/livekit_browser_sink.py /opt/teamaibox/services/trusted_media_service/
USER 65532:65532
LABEL org.teamaibox.claim="development-browser-service-not-product-accepted"
