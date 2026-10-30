ARG BASE_IMAGE=teamaibox/drawing-worker:drawing-provider-20260824-a1
FROM ${BASE_IMAGE}

USER root

ARG COMFYUI_REVISION=12d5279438bfefc058a269eae805ceab6047777f
ARG COMFYUI_ARCHIVE_SHA256=6d8ab87ec1250e60101f0caf9e11658834c29d9cd76c9174e2b84ec9436f4886

ENV COMFYUI_ROOT=/opt/comfyui \
    PYTHONPATH=/opt/comfyui

# ComfyUI is intentionally layered outside the existing Drawing Worker. The
# pinned archive keeps the integration non-invasive and independently
# replaceable while comfy-kitchen supplies the native Blackwell NVFP4 kernels.
RUN set -eu; \
    archive=/tmp/comfyui.tar.gz; \
    curl -fsSL "https://github.com/Comfy-Org/ComfyUI/archive/${COMFYUI_REVISION}.tar.gz" -o "${archive}"; \
    printf '%s  %s\n' "${COMFYUI_ARCHIVE_SHA256}" "${archive}" | sha256sum -c -; \
    mkdir -p "${COMFYUI_ROOT}"; \
    tar -xzf "${archive}" --strip-components=1 -C "${COMFYUI_ROOT}"; \
    rm -f "${archive}"; \
    sed -E '/^(torch|torchvision|torchaudio)$/d' "${COMFYUI_ROOT}/requirements.txt" \
      > /tmp/comfyui-runtime-requirements.txt; \
    python -m pip install --no-cache-dir --upgrade-strategy only-if-needed \
      --requirement /tmp/comfyui-runtime-requirements.txt; \
    rm -f /tmp/comfyui-runtime-requirements.txt; \
    find "${COMFYUI_ROOT}" -type d -name __pycache__ -prune -exec rm -rf '{}' +

RUN python -c "import comfy_kitchen; import torch; assert torch.__version__ == '2.13.0a0+8145d630e8.nv26.06'; assert torch.version.cuda is not None"

USER 65532:65532
WORKDIR /opt/comfyui

ENTRYPOINT ["python", "/opt/comfyui/main.py"]
