ARG BASE_IMAGE=teamaibox/drawing-provider:current-drawing-model-control-20260826-a2
FROM ${BASE_IMAGE}

USER root
COPY --chown=65532:65532 services/drawing-provider/server.py /opt/teamaibox/drawing-provider/server.py
COPY --chown=65532:65532 services/media_io/resources.py /opt/teamaibox/drawing-provider/media_resources.py

ENV DRAWING_PROVIDER_SERVED_MODEL=sdxl-base-1.0-fp16

USER 65532:65532
