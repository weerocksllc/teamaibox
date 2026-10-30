ARG PYTHON_BASE=python-base-must-be-pinned
FROM ${PYTHON_BASE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /opt/teamaibox/drawing-provider
COPY --chown=65532:65532 server.py ./server.py

USER 65532:65532
EXPOSE 19095
ENTRYPOINT ["python3", "/opt/teamaibox/drawing-provider/server.py"]
