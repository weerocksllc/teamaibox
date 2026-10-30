ARG BASE
FROM ${BASE}
COPY --chown=0:0 phone_browser_camera.py /opt/teamaibox/phone_browser_camera.py
COPY --chown=0:0 phone_camera_video_crosvm.py /opt/teamaibox/phone_camera_crosvm.py
COPY --chown=0:0 camera-frame-policy.json /opt/teamaibox/camera-frame-policy.json
