FROM docker.io/vllm/vllm-openai@sha256:e4f88a835143cd22aee2397a26ec6bb80b3a4a6fe0c882bcbc63822904766089
USER 0:0
RUN apt-get update && apt-get install -y --no-install-recommends ninja-build poppler-utils \
 && rm -rf /var/lib/apt/lists/*
COPY services/ocr-worker/worker_hunyuanocr /app/worker_hunyuanocr
COPY services/ocr-worker/managed_dflash_server.py /opt/teamaibox/ocr-worker/managed_dflash_server.py
COPY services/ocr-worker/managed_dflash_office_engine.py /opt/teamaibox/ocr-worker/managed_dflash_engine.py
COPY services/media_io/resources.py /opt/teamaibox/ocr-worker/media_resources.py
ENV PYTHONPATH=/app PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    TEAMAIBOX_HUNYUAN_ENGINE_PYTHON=python3
RUN python3 -c "from importlib.metadata import version; from worker_hunyuanocr.ocr_runtime import get_runtime; from vllm import LLM; from transformers import AutoProcessor; assert version('vllm') == '0.25.1'"
USER 65532:65532
EXPOSE 8000
ENTRYPOINT ["python3", "/opt/teamaibox/ocr-worker/managed_dflash_server.py"]
