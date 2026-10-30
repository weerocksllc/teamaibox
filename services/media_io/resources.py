"""Live memory admission for legacy buffered model protocols, not file quotas."""
from pathlib import Path
import os
import re
import subprocess


def available_memory():
    try:
        available = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()
                         if line.startswith('MemAvailable:'))
    except (OSError, StopIteration, ValueError):
        try:
            available = os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
        except (ValueError, OSError):
            # Local macOS developer tests use the same live-resource rule.
            stats = subprocess.check_output(['vm_stat'], text=True)
            page_size = int(re.search(r'page size of (\d+) bytes', stats)[1])
            available = sum(int(re.search(r'^'+name+r':\s+(\d+)', stats, re.M)[1])
                            for name in ['Pages free', 'Pages inactive', 'Pages speculative']) * page_size
    try:
        maximum = Path('/sys/fs/cgroup/memory.max').read_text().strip()
        if maximum != 'max':
            available = min(available, int(maximum) - int(Path('/sys/fs/cgroup/memory.current').read_text()))
    except (OSError, ValueError):
        pass
    return max(0, available)


def buffered_bytes(*, copies=8, configured=None, available=available_memory):
    """Budget copies of bytes, base64, JSON and decoded text against free RAM."""
    if type(copies) is not int or copies < 1:
        raise ValueError('invalid memory accounting')
    result = available() // copies
    if configured is not None:
        configured = int(configured)
        if configured < 1:
            raise ValueError('configured byte quota must be positive')
        result = min(result, configured)
    return result


def document_pages(source, workspace, *, pdf=False):
    """Render one PDF page at a time; remove it before advancing to the next."""
    if not pdf:
        yield source
        return
    import fitz
    from worker_hunyuanocr.pdf_pages import render_pdf_pages
    with fitz.open(source) as document:
        count = document.page_count
    if count < 1:
        raise ValueError('PDF contains no pages')
    for index in range(count):
        # Retain the model's existing rendering recipe without materializing
        # every page image or sending every page to the GPU in one batch.
        rendered = render_pdf_pages(source, metadata={'page_start': index, 'page_end': index})
        if len(rendered) != 1:
            raise RuntimeError('PDF page renderer returned an unexpected page count')
        path = workspace / 'page.png'
        try:
            path.write_bytes(rendered[0].image_data)
            del rendered
            yield path
        finally:
            path.unlink(missing_ok=True)
