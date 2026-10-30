# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
USER 0:0
# Start from the clean member runtime, NOT an image containing a test APK or
# checkerboard. Keep the original guest, networking and viewer unchanged.
RUN cp /opt/teamaibox/phone_network_start.py /opt/teamaibox/phone_network_base.py
COPY vhu_media_v4l2_stream_proxy camera-crosvm libgfxstream_backend.so /opt/teamaibox/camera-host/bin/
RUN mv /opt/teamaibox/camera-host/bin/camera-crosvm /opt/teamaibox/camera-host/bin/crosvm
COPY phone_camera_stream_start.py /opt/teamaibox/phone_network_start.py
COPY phone_camera_crosvm.py /opt/teamaibox/phone_camera_crosvm_base.py
COPY phone_camera_source_crosvm.py /opt/teamaibox/phone_camera_crosvm.py
COPY phone_camera_input.py phone_camera_client.py phone_camera_decode.py /opt/teamaibox/
COPY phone-camera-neutral-v1.jpg /opt/teamaibox/camera-neutral.jpg
COPY camera-decoder.whl camera-decoder.lock.json install_phone_camera_decoder.py /tmp/camera-build/
RUN python3 /tmp/camera-build/install_phone_camera_decoder.py && \
    chmod 0555 /opt/teamaibox/camera-host/bin/crosvm /opt/teamaibox/camera-host/bin/vhu_media_v4l2_stream_proxy /opt/teamaibox/phone_camera_crosvm.py && \
    chmod 0444 /opt/teamaibox/phone_camera_*.py /opt/teamaibox/camera-neutral.jpg && chmod 0555 /opt/teamaibox/phone_camera_crosvm.py && \
    /opt/teamaibox/camera-host/bin/vhu_media_v4l2_stream_proxy --help && /opt/teamaibox/phone_camera_crosvm.py --help
LABEL com.teamaibox.phone-camera="current-frame-mjpeg-image-v1" \
      org.opencontainers.image.description="Camera-capable AOSP runtime; default input off; separately verified before member selection"
USER 10001:10001
