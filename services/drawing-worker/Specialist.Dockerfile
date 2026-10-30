ARG PYTHON_BASE=python-base-must-be-pinned
FROM ${PYTHON_BASE}

COPY --chown=65532:65532 services/drawing-worker/specialist_server.py /opt/teamaibox/drawing-worker/specialist_server.py
COPY --chown=65532:65532 services/media_io/resources.py /opt/teamaibox/drawing-worker/media_resources.py
RUN chmod 0555 /opt/teamaibox/drawing-worker/specialist_server.py

USER 65532:65532
EXPOSE 8000
ENTRYPOINT ["python3", "/opt/teamaibox/drawing-worker/specialist_server.py"]
