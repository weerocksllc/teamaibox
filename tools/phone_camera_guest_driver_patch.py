"""Correct MMAP offsets returned by the pinned virtio-media guest driver.

QBUF is allowed to contain only type/memory/index for MMAP. The old driver
preserves its zeroed union over the host's authoritative buffer offset at DQBUF,
so Camera HAL subsequently maps buffer zero even when buffer one was dequeued.
USERPTR/DMABUF and the guest multi-plane-array pointer must still be preserved.
"""
COMMIT='00277701203bdfb6c5255afcc0948d29fe3e0248'

def adapt(source):
    if 'MMAP offsets belong to the device' in source:
        raise ValueError('guest_driver_already_patched')
    replacements={
        '\tdqbuf->buffer.m = buffer_m;':
        '\t/* MMAP offsets belong to the device, not to the QBUF caller. */\n'
        '\tif (V4L2_TYPE_IS_MULTIPLANAR(dqbuf->buffer.type) ||\n'
        '\t    dqbuf->buffer.memory != V4L2_MEMORY_MMAP)\n'
        '\t\tdqbuf->buffer.m = buffer_m;',
        '\t\t\tdqbuf->planes[i].m = plane_m;':
        '\t\t\tif (dqbuf->buffer.memory != V4L2_MEMORY_MMAP)\n'
        '\t\t\t\tdqbuf->planes[i].m = plane_m;',
    }
    for before,after in replacements.items():
        if source.count(before)!=1:raise ValueError('guest_driver_source_changed')
        source=source.replace(before,after)
    return source
