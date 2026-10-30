# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Exact browser-camera v2 parent; offline additions, no ROM publication.
FROM ${BUILD_PARENT_1}
USER root
COPY phone_camera_client.py phone_video_camera.py phone_video_camera_session.py phone_video_camera_worker.py phone_video_camera_control.py /opt/teamaibox/
COPY phone_camera_video_crosvm.py /opt/teamaibox/phone_camera_crosvm.py
RUN chmod 0444 /opt/teamaibox/phone_camera_client.py /opt/teamaibox/phone_video_camera*.py && chmod 0555 /opt/teamaibox/phone_camera_crosvm.py
LABEL com.teamaibox.phone-camera-video="experimental-product-candidate-not-published"
USER 10001:10001
