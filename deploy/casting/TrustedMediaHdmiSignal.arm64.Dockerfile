# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
COPY services/trusted_media_service/audio_signal_meter.py /opt/teamaibox/services/trusted_media_service/audio_signal_meter.py
COPY services/trusted_media_service/hdmi_media_output.py /opt/teamaibox/services/trusted_media_service/hdmi_media_output.py
COPY services/trusted_media_service/media_progress.py /opt/teamaibox/services/trusted_media_service/media_progress.py
