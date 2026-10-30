# No dependency or engine changes; use the exact already-installed ARM64 base.
ARG HUNYUAN_BASE
FROM ${HUNYUAN_BASE}
USER 0:0
COPY services/media_io/resources.py /opt/teamaibox/ocr-worker/media_resources.py
COPY --chown=65532:65532 services/ocr-worker/managed_dflash_server.py /opt/teamaibox/ocr-worker/managed_dflash_server.py
RUN chmod 0555 /opt/teamaibox/ocr-worker/managed_dflash_server.py
USER 65532:65532
