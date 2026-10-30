FROM python:3.11-slim@sha256:a630a63cdb314e2d138a2fca3e375e319e8568346ffafac5b980f888630ac4f1

RUN pip install --no-cache-dir --disable-pip-version-check huggingface-hub==0.34.4

ENV HOME=/tmp \
    USER=teamaibox \
    LOGNAME=teamaibox \
    PYTHONDONTWRITEBYTECODE=1

USER 65532:65532
ENTRYPOINT ["python3"]
