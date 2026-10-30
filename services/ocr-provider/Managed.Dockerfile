ARG PYTHON_BASE=python-base-must-be-pinned
FROM ${PYTHON_BASE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /opt/teamaibox/ocr-provider
COPY --chown=65532:65532 services/ocr-provider/managed_server.py ./managed_server.py
COPY --chown=65532:65532 services/media_io/resources.py ./media_resources.py
USER 65532:65532
EXPOSE 19095
ENTRYPOINT ["python3", "/opt/teamaibox/ocr-provider/managed_server.py"]
