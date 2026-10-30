FROM nvcr.io/nvidia/pytorch@sha256:43c018d6a12963f1a1bad85ef8574b5c2a978eec2be0ebcacfb87f69e0d210e1
USER 0:0
COPY services/drawing-worker/requirements.txt /tmp/teamaibox-drawing-requirements.txt
RUN python3 -m pip install --no-cache-dir -r /tmp/teamaibox-drawing-requirements.txt \
 && python3 -m pip uninstall --yes opencv-python \
 && python3 -m pip install --no-cache-dir --no-deps --force-reinstall opencv-python-headless==4.12.0.88 \
 && rm /tmp/teamaibox-drawing-requirements.txt \
 && python3 -c "from diffusers import Flux2KleinPipeline; from diffusers.hooks import apply_group_offloading"
COPY services/drawing-worker/flux2_bf16_protected_server.py /runtime/flux2_bf16_protected_server.py
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
ENTRYPOINT ["python3", "/runtime/flux2_bf16_protected_server.py"]
