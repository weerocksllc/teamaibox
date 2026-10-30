# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Offline, unpublished source-lifetime test. No guest/system/office changes.
FROM ${BUILD_PARENT_1}
COPY phone_browser_camera_session.py phone_browser_camera_control.py /opt/teamaibox/
LABEL com.teamaibox.phone-camera-browser="experimental-lease-not-published"
USER 10001:10001
