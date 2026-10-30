# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}

USER 0:0
RUN python3 -m pip install --no-cache-dir \
      huggingface-hub==1.29.0 \
      tokenizers==0.22.2 \
      transformers==5.9.0 \
    && (python3 -m pip check >/tmp/pip-check.txt 2>&1 || test $? -eq 1) \
    && python3 -c "from pathlib import Path; allowed={'invisible-watermark 0.2.0 requires opencv-python, which is not installed.','triton-kernels 1.0.0+gitb7fa781f.nv26.6 requires pytest, which is not installed.'}; lines=set(Path('/tmp/pip-check.txt').read_text().splitlines()); unknown=lines-allowed; assert not unknown, sorted(unknown)" \
    && rm /tmp/pip-check.txt
USER 65532:65532
