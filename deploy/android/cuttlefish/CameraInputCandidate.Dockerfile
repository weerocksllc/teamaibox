# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
USER 0:0
# Versioned derivative only. No user phone is updated by building this image.
RUN cp /opt/teamaibox/phone_camera_crosvm.py /opt/teamaibox/phone_camera_crosvm_base.py
COPY vhu_media_v4l2_stream_proxy /opt/teamaibox/camera-host/bin/vhu_media_v4l2_stream_proxy
COPY phone_camera_source_crosvm.py /opt/teamaibox/phone_camera_crosvm.py
COPY phone_camera_input.py /opt/teamaibox/phone_camera_input.py
COPY phone-camera-neutral-v1.jpg /opt/teamaibox/camera-neutral.jpg
RUN chmod 0555 /opt/teamaibox/camera-host/bin/vhu_media_v4l2_stream_proxy /opt/teamaibox/phone_camera_crosvm.py && chmod 0444 /opt/teamaibox/phone_camera_input.py /opt/teamaibox/phone_camera_crosvm_base.py /opt/teamaibox/camera-neutral.jpg && /opt/teamaibox/camera-host/bin/vhu_media_v4l2_stream_proxy --help && /opt/teamaibox/camera-host/bin/crosvm version
LABEL com.teamaibox.phone-camera="candidate-current-frame-input-only"
RUN /opt/teamaibox/phone_camera_crosvm.py --help
