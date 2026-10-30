# Docker Official Images repo-info, 3.12-slim-bookworm, blob
# 3b1213f76dd7c467ed4d0d514ec13220fc2577aa. Pin the public multi-platform index.
ARG PYTHON_IMAGE=docker.io/library/python@sha256:62ed8e07e544e8555c5d93748d5275015136b7f5c52b5e8679b4de339c3779d3
FROM ${PYTHON_IMAGE} AS builder

ARG ASR_MODEL_REPOSITORY=Systran/faster-whisper-small
ARG ASR_MODEL_REVISION=536b0662742c02347bc0e980a01041f333bce120
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    ASR_MODEL_REPOSITORY=${ASR_MODEL_REPOSITORY} \
    ASR_MODEL_REVISION=${ASR_MODEL_REVISION} \
    ASR_MODEL_TARGET=/opt/model
RUN python -m pip install \
      faster-whisper==1.2.1 \
      fastapi==0.116.1 \
      uvicorn==0.35.0 \
      python-multipart==0.0.20 \
      huggingface-hub==0.34.4
COPY services/realtime-asr-worker/build_model_snapshot.py /opt/teamaibox/build_model_snapshot.py
RUN python /opt/teamaibox/build_model_snapshot.py

FROM ${PYTHON_IMAGE}

ARG IMAGE_REVISION=unknown
ARG IMAGE_VERSION=0.1.0
ARG ASR_MODEL_REPOSITORY=Systran/faster-whisper-small
ARG ASR_MODEL_REVISION=536b0662742c02347bc0e980a01041f333bce120
LABEL org.opencontainers.image.title="Team AI Box Realtime ASR CPU Worker" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      com.teamaibox.plugin.id="official.compute.realtime-asr-cpu" \
      com.teamaibox.plugin.type="ComputePlugin" \
      com.teamaibox.architecture="linux/arm64/v8"

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local /usr/local
COPY --from=builder /opt/model /models/faster-whisper-small
COPY services/realtime-asr-worker/server.py /opt/teamaibox/server.py
COPY services/realtime-asr-worker/media_contract.py /opt/teamaibox/media_contract.py
COPY services/media_io/resources.py /opt/teamaibox/media_resources.py

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    ASR_MODEL_DIRECTORY=/models/faster-whisper-small \
    ASR_MODEL_ALIAS=whisper-small-ct2-int8 \
    ASR_MODEL_REPOSITORY=${ASR_MODEL_REPOSITORY} \
    ASR_MODEL_REVISION=${ASR_MODEL_REVISION} \
    ASR_CPU_THREADS=8 \
    ASR_MAX_UPLOAD_BYTES="" \
    ASR_HOST=0.0.0.0 \
    ASR_PORT=8080

RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin teamaibox \
    && chown -R 10001:10001 /models/faster-whisper-small /opt/teamaibox
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=6 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health/ready', timeout=2).read()"]
ENTRYPOINT ["python", "/opt/teamaibox/server.py"]
