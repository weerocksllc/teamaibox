#!/bin/bash
# Runs in an owned lab container, never on the appliance host.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends qemu-system-arm qemu-efi-aarch64 qemu-utils genisoimage openssh-client curl ca-certificates python3
qemu-system-aarch64 --version
file=/lab/debian-13-generic-arm64-20260831-2587.qcow2
test ! -e "$file"
curl --fail --location --connect-timeout 15 --max-time 650 \
  https://cloud.debian.org/images/cloud/trixie/20260831-2587/debian-13-generic-arm64-20260831-2587.qcow2 \
  -o "$file.partial"
python3 - "$file.partial" <<'PY'
import hashlib, sys
from pathlib import Path
p=Path(sys.argv[1])
h=hashlib.sha512()
with p.open('rb') as stream:
    for chunk in iter(lambda:stream.read(8*1024*1024),b''): h.update(chunk)
expected='27287048285224e662722b54c77849c9bd1a2fd60ccea5f2e75c644fbd638fad7e32a97e8e3d628c8bbfdb9cf757951c8300f3c21758647c8906359d9c892b42'
assert h.hexdigest()==expected, 'official cloud image checksum mismatch'
print('verifiedDebianCloudSha512='+h.hexdigest(),flush=True)
PY
mv "$file.partial" "$file"
qemu-img info --output=json "$file"
dpkg-query -W -f='${Package} ${Version}\n'
