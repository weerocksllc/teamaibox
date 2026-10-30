ARG BASE
FROM ${BASE}
COPY --chown=0:0 phone_video_camera.py /opt/teamaibox/phone_video_camera.py
