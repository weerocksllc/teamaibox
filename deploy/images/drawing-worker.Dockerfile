ARG PYTORCH_IMAGE=nvcr.io/nvidia/pytorch:26.05-py3@sha256:aa400d4373fa71f30e1714664beabcc64c2d198e72d65e9a3641440b07e7cc83
FROM ${PYTORCH_IMAGE}

ARG MODEL_REPOSITORY=stabilityai/stable-diffusion-xl-base-1.0
ARG MODEL_REVISION=462165984030d82259a11f4367a4eed129e94a7b

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp \
    LOGNAME=teamaibox \
    USER=teamaibox \
    USERNAME=teamaibox \
    XDG_CACHE_HOME=/tmp/.cache \
    TORCH_HOME=/tmp/torch \
    TORCHINDUCTOR_CACHE_DIR=/tmp/torchinductor \
    MPLCONFIGDIR=/tmp/matplotlib \
    HF_HOME=/var/cache/teamaibox/huggingface \
    HF_HUB_DISABLE_TELEMETRY=1 \
    TEAMAIBOX_DRAWING_MODEL_REPOSITORY=${MODEL_REPOSITORY} \
    TEAMAIBOX_DRAWING_MODEL_REVISION=${MODEL_REVISION} \
    TEAMAIBOX_DRAWING_MODEL_ROOT=/models/sdxl-base-1.0-fp16

WORKDIR /opt/teamaibox/drawing-worker
COPY services/drawing-worker/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --requirement requirements.txt
# invisible-watermark declares the GUI OpenCV wheel. The Spark worker is a
# headless compute container, so retain the explicitly pinned headless wheel
# and remove the GUI distribution metadata without touching the host OS.
RUN python -m pip uninstall --yes opencv-python \
    && python -m pip install --no-cache-dir --no-deps --force-reinstall opencv-python-headless==4.12.0.88 \
    && python -c "import cv2; assert cv2.__version__ == '4.12.0'"
COPY services/drawing-worker/server.py ./server.py
COPY services/media_io/resources.py ./media_resources.py
COPY services/drawing-worker/download_model.py ./download_model.py

RUN groupadd --gid 65532 teamaibox \
    && useradd --uid 65532 --gid 65532 --home-dir /tmp --no-create-home \
        --shell /usr/sbin/nologin teamaibox
USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=180s --retries=30 \
  CMD ["python", "-c", "import json,urllib.request; value=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2)); raise SystemExit(0 if value.get('accepting') and value.get('cuda') else 1)"]
ENTRYPOINT ["python", "/opt/teamaibox/drawing-worker/server.py"]
