"""Exact, build-time patch of the pinned upstream office OCR loader."""
import hashlib
from pathlib import Path

PARENT_SHA256 = 'ea35af38328c0273b68da490c57a0418b85dc6d3c7e8540999ddef82ac55615e'
KV_CACHE_BYTES = 1342177280  # 1.25 GiB; >= measured 0.91 GiB needed for 8192 tokens.
ANCHOR = '        "max_model_len": settings.VLLM_MAX_MODEL_LEN,\n'
INSERT = ('        # Main office OCR has one admitted request. Pin KV cache bytes\n'
          '        # instead of deriving them from a variable startup memory profile.\n'
          '        "kv_cache_memory_bytes": 1342177280,\n'
          '        "max_num_seqs": 1,\n')

def patched(source):
    if hashlib.sha256(source).hexdigest() != PARENT_SHA256:
        raise ValueError('upstream_ocr_loader_digest_changed')
    text = source.decode()
    if text.count(ANCHOR) != 1 or '"kv_cache_memory_bytes"' in text:
        raise ValueError('upstream_ocr_loader_anchor_changed')
    return text.replace(ANCHOR, ANCHOR+INSERT).encode()

if __name__ == '__main__':
    path = Path('/app/worker_hunyuanocr/ocr_runtime.py')
    path.write_bytes(patched(path.read_bytes()))
