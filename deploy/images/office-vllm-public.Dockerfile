# Same upstream NVIDIA engine and Transformers revision as the office profile.
# No developer registry, account state, model weights or cached containers.
FROM nvcr.io/nvidia/vllm@sha256:bebcf9576b1720214319ee5c7ee4f7661954cbbf59ed3fcd188cd79a67f1967e
USER 0:0
ARG TRANSFORMERS_COMMIT=2c7d385621c80fee70c1472f3a622fcba2c93fb9
RUN git init /tmp/transformers \
 && git -C /tmp/transformers remote add origin https://github.com/huggingface/transformers.git \
 && git -C /tmp/transformers fetch --depth=1 origin "$TRANSFORMERS_COMMIT" \
 && git -C /tmp/transformers checkout --detach FETCH_HEAD \
 && test "$(git -C /tmp/transformers rev-parse HEAD)" = "$TRANSFORMERS_COMMIT" \
 && python3 -m pip install --no-cache-dir --no-deps /tmp/transformers \
 && rm -rf /tmp/transformers \
 && python3 -c "from importlib.metadata import version; assert version('transformers') == '5.8.0.dev0'; assert version('vllm').startswith('0.22.1+7b9cb5b7')"
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false
USER 65532:65532
ENTRYPOINT ["vllm"]
