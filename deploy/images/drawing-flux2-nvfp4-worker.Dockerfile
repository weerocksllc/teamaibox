ARG BASE_IMAGE=teamaibox/drawing-comfyui:flux2-nvfp4-20260831-a2
FROM ${BASE_IMAGE}

USER root
COPY --chown=65532:65532 services/drawing-worker/flux2_comfy_server.py /opt/teamaibox/drawing-worker/flux2_comfy_server.py
COPY --chown=65532:65532 services/media_io/resources.py /opt/teamaibox/drawing-worker/media_resources.py

ENV TEAMAIBOX_DRAWING_SERVED_MODEL=flux2-klein-4b-nvfp4 \
    TEAMAIBOX_DRAWING_MODEL_ROOT=/model/nvfp4 \
    TEAMAIBOX_DRAWING_COMPONENT_ROOT=/components \
    TEAMAIBOX_COMFY_ROOT=/opt/comfyui \
    TEAMAIBOX_DRAWING_WORK_ROOT=/tmp/teamaibox-flux2-worker

USER 65532:65532
EXPOSE 8000
ENTRYPOINT ["python3", "/opt/teamaibox/drawing-worker/flux2_comfy_server.py"]
