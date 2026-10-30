# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
USER 0:0
# The media backend requires the matching SHMEM protocol in the pinned official
# crosvm package. Keep it private to this candidate; original binaries, guest
# images, streamer access controls and host-installed packages are untouched.
RUN cp /opt/teamaibox/phone_network_start.py /opt/teamaibox/phone_network_base.py
COPY vhu_media_v4l2_stream_proxy /opt/teamaibox/camera-host/bin/vhu_media_v4l2_stream_proxy
COPY camera-crosvm /opt/teamaibox/camera-host/bin/crosvm
COPY libgfxstream_backend.so /opt/teamaibox/camera-host/bin/libgfxstream_backend.so
COPY phone_camera_stream_start.py /opt/teamaibox/phone_network_start.py
COPY phone_camera_crosvm.py /opt/teamaibox/phone_camera_crosvm.py
COPY phone-camera-fixture-v1.apk /opt/teamaibox/test-camera.apk
COPY phone-camera-checker-v1.jpg /opt/teamaibox/camera-checker.jpg
RUN chmod 0555 /opt/teamaibox/camera-host/bin/vhu_media_v4l2_stream_proxy /opt/teamaibox/camera-host/bin/crosvm /opt/teamaibox/phone_camera_crosvm.py && chmod 0444 /opt/teamaibox/phone_network_start.py /opt/teamaibox/phone_network_base.py /opt/teamaibox/test-camera.apk && /opt/teamaibox/camera-host/bin/vhu_media_v4l2_stream_proxy --help && /opt/teamaibox/camera-host/bin/crosvm version
LABEL com.teamaibox.phone-camera="candidate-synthetic-stream-only"
