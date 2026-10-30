#!/bin/bash
# ONLY executed inside the disposable ARM Linux VM, not an appliance host.
set -euo pipefail
test "$(hostname)" = android-lab
test -f /home/lab/waydroid-system.zip
test -f /home/lab/waydroid-vendor.zip
python3 - <<'PY'
import hashlib
from pathlib import Path
for name,expected in (
 ('system','c4b45fad36bee7c0db8a1d9315a5be0035520c53d3d005a807735ae9b7ee79cf'),
 ('vendor','1e6d33d464277ea3964e4658001c8882f21325616d6bcc66d473bc9ee1e246c7')):
 p=Path('/home/lab/waydroid-'+name+'.zip'); h=hashlib.sha256()
 with p.open('rb') as stream:
  for data in iter(lambda:stream.read(8*1024*1024),b''):h.update(data)
 assert h.hexdigest()==expected,name+' image mismatch'
 print(name+' sha256 '+h.hexdigest(),flush=True)
PY
# Signed Debian repositories; no remote shell installer.
sudo install -d /etc/apt/sources.list.d
sudo python3 - <<'PY'
from pathlib import Path
Path('/etc/apt/sources.list.d/android-lab-backports.sources').write_text('Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie-backports\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n')
PY
sudo apt-get update -qq
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends weston dbus-x11 unzip pulseaudio
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -t trixie-backports waydroid=1.6.3+ds-2~bpo13+1
sudo systemctl stop waydroid-container
sudo install -d /etc/waydroid-extra/images
sudo unzip -q /home/lab/waydroid-system.zip -d /etc/waydroid-extra/images
sudo unzip -q /home/lab/waydroid-vendor.zip -d /etc/waydroid-extra/images
sudo waydroid init
sudo python3 - <<'PY'
import configparser
from pathlib import Path
p=Path('/var/lib/waydroid/waydroid.cfg'); c=configparser.ConfigParser();c.read(p)
if not c.has_section('properties'):c.add_section('properties')
c['properties']['ro.hardware.gralloc']='default'
c['properties']['ro.hardware.egl']='swiftshader'
c['properties']['persist.waydroid.width']='720'
c['properties']['persist.waydroid.height']='1280'
with p.open('w') as out:c.write(out)
PY
sudo waydroid upgrade -o
sudo python3 - <<'PY'
from pathlib import Path
p=Path('/var/lib/waydroid/lxc/waydroid/config')
with p.open('a') as out:out.write('\nlxc.cgroup2.memory.max = 4294967296\nlxc.cgroup2.memory.swap.max = 0\nlxc.cgroup2.cpu.max = 400000 100000\n')
PY
sudo systemctl start waydroid-container
export XDG_RUNTIME_DIR=/run/user/1000
export WAYLAND_DISPLAY=android-lab-wayland
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
dbus-run-session -- bash -c '
  set -e
  weston --backend=headless-backend.so --renderer=pixman --socket=android-lab-wayland --width=720 --height=1280 --idle-time=0 > /home/lab/weston.log 2>&1 &
  weston_pid=$!
  trap "kill $weston_pid 2>/dev/null || true" EXIT
  for n in $(seq 1 30); do test -S /run/user/1000/android-lab-wayland && break; sleep 1; done
  test -S /run/user/1000/android-lab-wayland
  pulseaudio --start --exit-idle-time=-1
  waydroid session start > /home/lab/waydroid-session.log 2>&1 &
  session_pid=$!
  for n in $(seq 1 90); do
    ready=$(sudo waydroid shell getprop sys.boot_completed 2>/dev/null | tr -d "\r")
    if test "$ready" = 1; then
      echo ANDROID_LAB_WAYDROID_BOOTED
      sudo waydroid shell getprop
      sudo waydroid shell dumpsys SurfaceFlinger
      waydroid show-full-ui
      sleep 20
      waydroid session stop
      exit 0
    fi
    sleep 2
  done
  tail -80 /home/lab/waydroid-session.log
  sudo waydroid log -n 80
  exit 1
'
