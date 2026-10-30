# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
COPY services/trusted_media_service/hdmi_media_output.py /opt/teamaibox/services/trusted_media_service/hdmi_media_output.py
COPY services/trusted_media_service/display_lease_client.py /opt/teamaibox/services/trusted_media_service/display_lease_client.py
# Corresponding source for the separately installed host boundary and its tests.
COPY tools/casting_display_lease_host.py /opt/teamaibox/tools/casting_display_lease_host.py
