ARG HUNYUAN_BASE
FROM ${HUNYUAN_BASE}

USER 0:0
COPY services/media_io/resources.py /opt/teamaibox/ocr-worker/media_resources.py
RUN if ! command -v ninja >/dev/null 2>&1; then \
      apt-get update \
      && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ninja-build \
      && rm -rf /var/lib/apt/lists/*; \
    fi

COPY --chown=65532:65532 services/ocr-worker/managed_dflash_server.py /opt/teamaibox/ocr-worker/managed_dflash_server.py

USER 65532:65532
