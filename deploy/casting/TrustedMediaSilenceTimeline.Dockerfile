ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY services/trusted_media_service/webrtc_media_output.py /opt/teamaibox/services/trusted_media_service/webrtc_media_output.py
