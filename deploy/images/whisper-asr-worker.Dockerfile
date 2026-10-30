ARG ASR_BASE_IMAGE
FROM ${ASR_BASE_IMAGE}

ARG IMAGE_REVISION=unknown
ARG IMAGE_VERSION=0.1.0
LABEL org.opencontainers.image.title="Team AI Box Whisper ASR Compute Worker" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      com.teamaibox.plugin.id="official.compute.asr-whisper-large-v3" \
      com.teamaibox.plugin.type="ComputePlugin" \
      com.teamaibox.architecture="linux/arm64/v8"

WORKDIR /opt/teamaibox
COPY dependencies/more_itertools-10.8.0-py3-none-any.whl /opt/dependencies/more_itertools-10.8.0-py3-none-any.whl
RUN python -m pip install --no-index --no-deps --disable-pip-version-check \
      /opt/dependencies/more_itertools-10.8.0-py3-none-any.whl \
    && python -c "import importlib.metadata; assert importlib.metadata.version('more-itertools') == '10.8.0'" \
    && rm /opt/dependencies/more_itertools-10.8.0-py3-none-any.whl
COPY --chown=1000:1000 whisper-source/whisper/ /opt/whisper/whisper/
COPY --chown=1000:1000 tools/whisper_asr_worker.py /opt/teamaibox/worker.py

ENV PYTHONPATH=/opt/whisper \
    WHISPER_MODEL_DIR=/models \
    WHISPER_MODEL_NAME=large-v3 \
    WHISPER_MODEL_ALIAS=whisper-large-v3-fp16 \
    WHISPER_MODEL_SHA256=e5b1a55b89c1367dacf97e3e19bfd829a01529dbfdeefa8caeb59b3f1b81dadb \
    WHISPER_MAX_UPLOAD_BYTES=268435456 \
    TRITON_CACHE_DIR=/var/cache/triton \
    WHISPER_HOST=0.0.0.0 \
    WHISPER_PORT=8080

USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["python", "/opt/teamaibox/worker.py"]
