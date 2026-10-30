FROM docker.io/library/golang@sha256:36775b15988ba37410576be98e8628fc1bf25a09c3d9afc7f5e3c3d328a063ae AS inputs
WORKDIR /build
COPY services/speaker-diarization-worker/supervisor/main.go ./main.go
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o supervisor main.go
RUN curl -fsSL --retry 2 --connect-timeout 30 --max-time 1800 \
      https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-linux-aarch64-cuda12.tar.gz -o runtime.tar.gz \
 && echo '20ab68b0f8b4ace1e30b6605859935b1a059fc149d7b24f7a4b4d95cbf2f0c2d  runtime.tar.gz' | sha256sum -c - \
 && mkdir runtime && tar -xzf runtime.tar.gz --strip-components=1 -C runtime
RUN curl -fsSL --retry 2 --connect-timeout 30 --max-time 1800 \
      https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2/resolve/5240a64075176943f677d30fa2171c780229f341/diar_streaming_sortformer_4spk-v2.q8_0.gguf -o model.gguf \
 && echo '0679cfeb1ce356d0dea9470b31274f4bfc7eb927497d82005483770666da998a  model.gguf' | sha256sum -c -

FROM docker.io/library/ubuntu@sha256:95fa486768020359141f1318720f43e7982ef926c792891d984aef9aaf05e7ea
COPY --from=inputs /build/runtime /opt/nemo-speech
COPY --from=inputs /build/supervisor /usr/local/bin/speaker-diarization-supervisor
COPY --from=inputs /build/model.gguf /models/diar_streaming_sortformer_4spk-v2.q8_0.gguf
ENV HOME=/tmp LD_LIBRARY_PATH=/opt/nemo-speech/lib NVIDIA_DRIVER_CAPABILITIES=compute,utility NVIDIA_VISIBLE_DEVICES=all TEAMAIBOX_DIARIZATION_IDLE_UNLOAD_SECONDS=300
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/speaker-diarization-supervisor"]
