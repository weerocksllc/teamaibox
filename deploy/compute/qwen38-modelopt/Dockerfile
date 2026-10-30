ARG OFFICE_ENGINE_IMAGE
FROM ${OFFICE_ENGINE_IMAGE}

ARG MODEL_OPT_COMMIT=51cc5dbadeedd93cba5cc37eec637f26efd3f8ab

USER root
RUN git init /opt/modelopt \
    && git -C /opt/modelopt remote add origin https://github.com/NVIDIA/Model-Optimizer.git \
    && git -C /opt/modelopt fetch --depth=1 origin "${MODEL_OPT_COMMIT}" \
    && git -C /opt/modelopt checkout --detach FETCH_HEAD \
    && test "$(git -C /opt/modelopt rev-parse HEAD)" = "${MODEL_OPT_COMMIT}" \
    && printf '%s\n' "${MODEL_OPT_COMMIT}" > /opt/modelopt/.teamaibox-source-commit \
    && python3 -m pip install --no-cache-dir \
        accelerate==1.10.1 \
        datasets==5.0.0 \
        nltk==3.9.1 \
        omegaconf==2.3.0 \
        peft==0.20.0 \
        pulp==3.3.0 \
        wonderwords==2.2.0 \
    && python3 -m pip install --no-cache-dir --no-build-isolation --no-deps /opt/modelopt \
    && python3 -c "import subprocess; p=subprocess.run(['python3','-m','pip','check'],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT); lines=[x for x in p.stdout.splitlines() if x]; allowed=('vllm 0.22.1+7b9cb5b7.nv26.6.55915567 has requirement apache-tvm-ffi==0.1.9, but you have apache-tvm-ffi 0.1.7.','vllm 0.22.1+7b9cb5b7.nv26.6.55915567 has requirement transformers==5.6.0, but you have transformers 5.8.0.dev0.','xgrammar 0.2.0 has requirement apache-tvm-ffi>=0.1.9, but you have apache-tvm-ffi 0.1.7.'); unexpected=[x for x in lines if x not in allowed]; print('\\n'.join(lines)); assert not unexpected, unexpected"

LABEL org.opencontainers.image.source="https://github.com/NVIDIA/Model-Optimizer" \
      com.teamaibox.modelopt.commit="${MODEL_OPT_COMMIT}" \
      com.teamaibox.model.family="qwen3.8-27b" \
      com.teamaibox.model.quantization="modelopt-nvfp4-fp8-hybrid"

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    PYTHONUNBUFFERED=1 \
    TOKENIZERS_PARALLELISM=false

WORKDIR /opt/modelopt/examples/hf_ptq
ENTRYPOINT []
