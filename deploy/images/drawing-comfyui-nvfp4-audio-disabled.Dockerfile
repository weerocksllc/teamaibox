ARG BASE_IMAGE=teamaibox/drawing-comfyui:flux2-nvfp4-20260831-a1
FROM ${BASE_IMAGE}

USER root

# ComfyUI imports optional audio modules while registering its media model
# classes. This image is a Drawing-only worker, so provide an explicit import
# boundary instead of installing a public torchaudio wheel that does not match
# the pinned NVIDIA 26.06 PyTorch ABI. Any accidental audio call fails closed.
RUN set -eu; \
    package=/opt/teamaibox-torchaudio-disabled/torchaudio; \
    mkdir -p "${package}"; \
    printf '%s\n' \
      'def _unavailable(*args, **kwargs):' \
      '    raise RuntimeError("torchaudio is disabled in the dedicated Team AI Box Drawing runtime")' \
      '' \
      'class MelSpectrogram:' \
      '    def __init__(self, *args, **kwargs): _unavailable()' \
      '' \
      'class MelScale:' \
      '    def __init__(self, *args, **kwargs): _unavailable()' \
      > "${package}/transforms.py"; \
    printf '%s\n' \
      'def _unavailable(*args, **kwargs):' \
      '    raise RuntimeError("torchaudio is disabled in the dedicated Team AI Box Drawing runtime")' \
      'resample = _unavailable' \
      'bass_biquad = _unavailable' \
      'equalizer_biquad = _unavailable' \
      'treble_biquad = _unavailable' \
      > "${package}/functional.py"; \
    printf '%s\n' \
      'from . import functional, transforms' \
      '__version__ = "disabled-drawing-runtime"' \
      > "${package}/__init__.py"

# The inherited worker runs as numeric uid/gid 65532. Register that identity so
# Python/getpass and PyTorch's compile-cache discovery remain deterministic in
# the rootless production container.
RUN set -eu; \
    getent group 65532 >/dev/null 2>&1 || printf '%s\n' 'teamaibox:x:65532:' >> /etc/group; \
    getent passwd 65532 >/dev/null 2>&1 || \
      printf '%s\n' 'teamaibox:x:65532:65532:Team AI Box runtime:/tmp:/bin/false' >> /etc/passwd

ENV PYTHONPATH=/opt/teamaibox-torchaudio-disabled:/opt/comfyui

RUN python -c "import torch,torchaudio; assert torch.__version__ == '2.13.0a0+8145d630e8.nv26.06'; assert torchaudio.__version__ == 'disabled-drawing-runtime'"

USER 65532:65532
