ARG HUNYUAN_BASE
FROM ${HUNYUAN_BASE}
USER 0:0
COPY services/media_io/resources.py /opt/teamaibox/ocr-worker/media_resources.py
COPY --chown=65532:65532 services/ocr-worker/managed_dflash_office_server.py /opt/teamaibox/ocr-worker/managed_dflash_server.py
COPY --chown=65532:65532 services/ocr-worker/managed_dflash_office_engine.py /opt/teamaibox/ocr-worker/managed_dflash_engine.py
COPY services/ocr-worker/patch_office_vllm_cache.py /opt/teamaibox/ocr-worker/patch_office_vllm_cache.py
RUN python3 /opt/teamaibox/ocr-worker/patch_office_vllm_cache.py && chmod 0555 /opt/teamaibox/ocr-worker/managed_dflash_server.py /opt/teamaibox/ocr-worker/managed_dflash_engine.py
USER 65532:65532
