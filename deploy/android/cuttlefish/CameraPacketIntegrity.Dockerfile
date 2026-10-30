ARG BASE
FROM ${BASE}
COPY --chown=10001:10001 phone_browser_camera.py /opt/teamaibox/phone_browser_camera.py
