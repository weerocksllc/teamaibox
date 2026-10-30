FROM docker.m.daocloud.io/library/ubuntu@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea

ARG NEMO_SPEECH_ARCHIVE_SHA256=20ab68b0f8b4ace1e30b6605859935b1a059fc149d7b24f7a4b4d95cbf2f0c2d
ARG DIARIZATION_MODEL_SHA256=0679cfeb1ce356d0dea9470b31274f4bfc7eb927497d82005483770666da998a

COPY nemo-speech.tar.gz /tmp/nemo-speech.tar.gz
COPY diar_streaming_sortformer_4spk-v2.q8_0.gguf /tmp/diarization.gguf
COPY speaker-diarization-supervisor /usr/local/bin/speaker-diarization-supervisor

RUN set -eu; \
    printf '%s  %s\n' "$NEMO_SPEECH_ARCHIVE_SHA256" /tmp/nemo-speech.tar.gz | sha256sum -c -; \
    printf '%s  %s\n' "$DIARIZATION_MODEL_SHA256" /tmp/diarization.gguf | sha256sum -c -; \
    mkdir -p /opt/nemo-speech /models; \
    tar -xzf /tmp/nemo-speech.tar.gz -C /opt/nemo-speech --strip-components=1; \
    mv /tmp/diarization.gguf /models/diar_streaming_sortformer_4spk-v2.q8_0.gguf; \
    rm /tmp/nemo-speech.tar.gz; \
    groupadd --system --gid 65532 teamaibox; \
    useradd --system --uid 65532 --gid 65532 --home-dir /nonexistent --shell /usr/sbin/nologin teamaibox; \
    chown -R 65532:65532 /opt/nemo-speech /models; \
    chmod -R a-w /opt/nemo-speech /models; \
    chown 65532:65532 /usr/local/bin/speaker-diarization-supervisor; \
    chmod 0555 /usr/local/bin/speaker-diarization-supervisor

ENV HOME=/tmp \
    LD_LIBRARY_PATH=/opt/nemo-speech/lib \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    NVIDIA_VISIBLE_DEVICES=all \
    TEAMAIBOX_DIARIZATION_IDLE_UNLOAD_SECONDS=300

LABEL com.teamaibox.managed="true" \
      com.teamaibox.component="speaker-diarization-worker" \
      com.teamaibox.plugin.id="official.compute.speaker-diarization" \
      com.teamaibox.plugin.type="ComputePlugin" \
      com.teamaibox.architecture="linux/arm64/v8" \
      com.teamaibox.runtime.version="nemo-speech-0.1.0" \
      com.teamaibox.runtime.sha256="sha256:20ab68b0f8b4ace1e30b6605859935b1a059fc149d7b24f7a4b4d95cbf2f0c2d" \
      com.teamaibox.model.revision="5240a64075176943f677d30fa2171c780229f341" \
      com.teamaibox.model.sha256="sha256:0679cfeb1ce356d0dea9470b31274f4bfc7eb927497d82005483770666da998a"

USER 65532:65532
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=9 \
  CMD ["/bin/bash", "-ec", "exec 3<>/dev/tcp/127.0.0.1/8080; printf 'GET /ready HTTP/1.0\\r\\n\\r\\n' >&3; read -r status <&3; [[ $status == *' 200 '* ]]"]

ENTRYPOINT ["/usr/local/bin/speaker-diarization-supervisor"]
