#!/bin/bash
# Evaluation only, inside the private ARM KVM VM. Never run on an appliance host.
set -euo pipefail
test "$(hostname)" = android-lab
python3 - <<'PY'
import hashlib
from pathlib import Path
for name, expected in (
 ('system','c3cf6ab5ded7496761bae4a49fe1a6f691923c5b84818755790f3ae4e239127b'),
 ('vendor','bad5e84a2a47b877d8a85f6a212720f5562e3eeb26696bfd0e2de50dab1ec3ba')):
 p=Path('/home/lab/waydroid64-'+name+'.zip'); h=hashlib.sha256()
 with p.open('rb') as stream:
  for data in iter(lambda:stream.read(8*1024*1024),b''):h.update(data)
 assert h.hexdigest()==expected,name+' image mismatch'
 print(name+' sha256 '+h.hexdigest(),flush=True)
PY
sudo python3 - <<'PY'
from pathlib import Path
Path('/etc/apt/sources.list.d/android-lab-backports.sources').write_text('Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie-backports\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n')
PY
sudo apt-get update -qq
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends weston dbus-x11 unzip pulseaudio
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -t trixie-backports waydroid=1.6.3+ds-2~bpo13+1
sudo systemctl stop waydroid-container
sudo install -d /etc/waydroid-extra/images
sudo unzip -q /home/lab/waydroid64-system.zip -d /etc/waydroid-extra/images
sudo unzip -q /home/lab/waydroid64-vendor.zip -d /etc/waydroid-extra/images
sudo waydroid init
sudo python3 - <<'PY'
import configparser
from pathlib import Path
p=Path('/var/lib/waydroid/waydroid.cfg'); c=configparser.ConfigParser();c.read(p)
if not c.has_section('properties'):c.add_section('properties')
c['properties'].update({'ro.hardware.gralloc':'default','ro.hardware.egl':'swiftshader',
 'persist.waydroid.width':'720','persist.waydroid.height':'1280'})
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
  weston --shell=kiosk-shell.so --backend=headless-backend.so --renderer=pixman --socket=android-lab-wayland --width=720 --height=1280 --idle-time=0 > /home/lab/weston.log 2>&1 &
  weston_pid=$!
  trap "kill $weston_pid 2>/dev/null || true" EXIT
  for n in $(seq 1 30); do test -S /run/user/1000/android-lab-wayland && break; sleep 1; done
  test -S /run/user/1000/android-lab-wayland
  pulseaudio --start --exit-idle-time=-1
  started=$(date +%s)
  waydroid session start > /home/lab/waydroid-session.log 2>&1 &
  for n in $(seq 1 90); do
    ready=$(timeout 5 sudo waydroid shell -- getprop sys.boot_completed 2>/dev/null | tr -d "\r") || ready=""
    if test "$ready" = 1; then
      echo ANDROID_LAB_WAYDROID_BOOTED
      echo "ANDROID_LAB_BOOT_SECONDS=$(( $(date +%s) - started ))"
      sudo waydroid shell -- getprop
      sudo waydroid shell -- dumpsys SurfaceFlinger
      sudo lxc-cgroup -P /var/lib/waydroid/lxc -n waydroid memory.max
      sudo lxc-cgroup -P /var/lib/waydroid/lxc -n waydroid memory.swap.max
      waydroid show-full-ui &
      sleep 2
      waydroid adb connect
      python3 /home/lab/waydroid-adb-authorize.py
      adb devices -l
      adb shell -n getprop ro.product.cpu.abilist
      adb shell -n pm list packages
      adb shell -n am start -W -a android.settings.SETTINGS
      sleep 3
      adb shell -n screencap -p /data/local/tmp/android-lab-settings.png
      adb pull /data/local/tmp/android-lab-settings.png /home/lab/settings.png
      adb shell -n ls -ld /sdcard/Download || true
      sleep 30
      waydroid session stop
      exit 0
    fi
    if test "$n" -gt 10 && ! sudo lxc-info -P /var/lib/waydroid/lxc -n waydroid -sH | grep -qx RUNNING; then break; fi
    sleep 2
  done
  tail -80 /home/lab/waydroid-session.log
  sudo timeout 15 waydroid shell -- logcat -d -b crash -t 100
  sudo tail -100 /var/lib/waydroid/waydroid.log
  sudo journalctl -k -b --no-pager -n 100
  exit 1
'
