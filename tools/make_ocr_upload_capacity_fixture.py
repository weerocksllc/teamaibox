"""Synthetic transport fixture: unchanged small PNG plus inert trailing bytes.

This exercises byte admission, not megapixel capacity or OCR quality on a large
document. No user image is used or modified.
"""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parents[1]
source=root/'tmp/postboot-ocr-fixture-20260907-a1.png'
target=root/'tmp/ocr-resource-upload-65mib-20260916-a1.png'
raw=source.read_bytes()
assert raw[:8]==b'\x89PNG\r\n\x1a\n' and len(raw)<1024*1024
with target.open('xb') as f:
 f.write(raw)
 remaining=65*1024*1024-len(raw)
 while remaining:
  block=bytes(min(1024*1024,remaining));f.write(block);remaining-=len(block)
print(json.dumps({'file':str(target),'bytes':target.stat().st_size,'sourceSha256':hashlib.sha256(raw).hexdigest(),'purpose':'transport-admission-only'}))
