ARG HUNYUAN_BASE=hunyuan-base-must-be-pinned
FROM ${HUNYUAN_BASE}

USER root
COPY services/media_io/resources.py /opt/teamaibox/ocr-worker/media_resources.py
COPY --chown=65532:65532 services/ocr-worker/managed_dflash_server.py /opt/teamaibox/ocr-worker/managed_dflash_server.py
COPY --chown=65532:65532 services/ocr-worker/managed_dflash_engine.py /opt/teamaibox/ocr-worker/managed_dflash_engine.py
RUN chmod 0555 /opt/teamaibox/ocr-worker/managed_dflash_server.py /opt/teamaibox/ocr-worker/managed_dflash_engine.py

USER 65532:65532
EXPOSE 8000
ENTRYPOINT ["python3", "/opt/teamaibox/ocr-worker/managed_dflash_server.py"]
