ARG BASE
FROM ${BASE}
COPY --chown=0:0 phone_camera_client.py phone_camera_decode.py phone_video_camera.py phone_files.py /opt/teamaibox/
COPY --chown=0:0 resources.py /opt/teamaibox/media_resources.py
