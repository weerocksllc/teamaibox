# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Experimental adapter build only. No member ROM mapping or Android start.
FROM ${BUILD_PARENT_1}
USER 0:0
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-gi gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 \
    gir1.2-gst-plugins-bad-1.0 gir1.2-nice-0.1 \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-nice && \
    apt-get clean
COPY phone_browser_camera.py /opt/teamaibox/
LABEL com.teamaibox.phone-camera-browser="experimental-not-published"
USER 10001:10001
