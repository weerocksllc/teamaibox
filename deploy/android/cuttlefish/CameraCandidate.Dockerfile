# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
USER 0:0
RUN cp /opt/teamaibox/phone_network_start.py /opt/teamaibox/phone_network_base.py
COPY phone_camera_start.py /opt/teamaibox/phone_network_start.py
COPY phone-camera-fixture-v1.apk /opt/teamaibox/test-camera.apk
RUN chmod 0444 /opt/teamaibox/phone_network_start.py /opt/teamaibox/phone_network_base.py /opt/teamaibox/test-camera.apk
LABEL com.teamaibox.phone-camera="candidate-synthetic-only"
