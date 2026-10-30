"""Derive the current-frame transport without changing the passed FIFO build."""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def adapt(name,source):
    if name=='v4l2_stream_proxy/src/worker.rs':
        return (ROOT/'deploy/android/cuttlefish/camera-input/worker.rs').read_text()
    if name=='vhu_media/src/lib.rs':
        before='            len: 1,'
        if source.count(before)!=1:raise RuntimeError('mmap_upstream_context_changed')
        source=source.replace(before,'            len: end - shm_offset + 1,')
        before='            | VhostUserProtocolFeatures::SHMEM\n'
        if source.count(before)!=1:raise RuntimeError('shmem_protocol_context_changed')
        # Shared mappings must be acknowledged before the guest uses/reuses them.
        return source.replace(before,before+'            | VhostUserProtocolFeatures::REPLY_ACK\n')
    return source
