# Same upstream NVIDIA engine and Transformers revision as the office profile.
# No developer registry, account state, model weights or cached containers.
FROM nvcr.io/nvidia/vllm@sha256:bebcf9576b1720214319ee5c7ee4f7661954cbbf59ed3fcd188cd79a67f1967e
USER 0:0
ADD --checksum=sha256:a188229a155f2c0c5367f163415ad426b320949814cd302e550a354421642706 \
    https://codeload.github.com/huggingface/transformers/tar.gz/2c7d385621c80fee70c1472f3a622fcba2c93fb9 /tmp/transformers.tar.gz
RUN mkdir /tmp/transformers \
 && tar -xzf /tmp/transformers.tar.gz --strip-components=1 --no-same-owner -C /tmp/transformers \
 && python3 -m pip install --no-cache-dir --no-deps /tmp/transformers \
 && rm -rf /tmp/transformers /tmp/transformers.tar.gz \
 && python3 -c "from importlib.metadata import version; assert version('transformers') == '5.8.0.dev0'; assert version('vllm').startswith('0.22.1+7b9cb5b7')"
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false
USER 65532:65532
ENTRYPOINT ["vllm"]
