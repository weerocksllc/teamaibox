#!/bin/bash
set -euo pipefail
ulimit -c 0
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates python3 unzip file procps \
  libcap2 libcurl4t64 libdrm2 libegl1 libgl1 libfdt1 libglib2.0-0t64 liblzma5 \
  libssl3t64 libvulkan1 libwayland-client0 libwayland-server0 libx11-6 libxext6 \
  libxml2 libz3-4 mesa-vulkan-drivers iproute2 iptables dnsmasq-base net-tools openssl
mkdir /lab/cf-a3
tar --no-same-owner -xzf /lab/cvd-host_package.tar.gz -C /lab/cf-a3
unzip -q /lab/aosp_cf_arm64_only_phone-img-16102939.zip -d /lab/cf-a3
cd /lab/cf-a3
export ANDROID_HOST_OUT=/lab/cf-a3
export ANDROID_PRODUCT_OUT=/lab/cf-a3
file bin/crosvm bin/launch_cvd bin/assemble_cvd
# crosvm is a shell dispatcher in this official host package, not an ELF binary.
head -30 bin/crosvm
ldd bin/assemble_cvd
bin/launch_cvd --help > /lab/launch-help-a3.txt 2>&1 || true
bin/crosvm --help
dpkg-query -W -f='${Package} ${Version}\n' > /lab/prepared-packages-a3.txt
printf 'Cuttlefish tools prepared; Android not started.\n'
