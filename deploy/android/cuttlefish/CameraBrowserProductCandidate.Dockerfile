# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Offline candidate only. ROM creation stays disabled pending Android tests.
FROM ${BUILD_PARENT_1}
USER root
COPY phone_camera_client.py /opt/teamaibox/
COPY phone_camera_browser_start.py /opt/teamaibox/phone_network_start.py
COPY phone_camera_browser_crosvm.py /opt/teamaibox/phone_camera_crosvm.py
RUN chmod 0444 /opt/teamaibox/phone_camera_client.py /opt/teamaibox/phone_network_start.py && chmod 0555 /opt/teamaibox/phone_camera_crosvm.py
LABEL com.teamaibox.phone-camera-browser="experimental-product-candidate-not-published"
USER 10001:10001
