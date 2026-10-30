#!/bin/bash
# Run only inside a clone of the successful private Waydroid lab VM.
set -euo pipefail
test "$(hostname)" = android-lab
export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=android-lab-wayland
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
sudo systemctl start waydroid-container
dbus-run-session -- bash -c '
set -e
weston --shell=kiosk-shell.so --backend=headless-backend.so --renderer=pixman --socket=android-lab-wayland --width=720 --height=1280 --idle-time=0 >/home/lab/weston-followup.log 2>&1 &
weston_pid=$!
trap "waydroid session stop >/dev/null 2>&1 || true; kill $weston_pid 2>/dev/null || true" EXIT
for n in $(seq 1 30); do test -S /run/user/1000/android-lab-wayland && break; sleep 1; done
pulseaudio --start --exit-idle-time=-1
waydroid session start >/home/lab/waydroid-followup.log 2>&1 &
for n in $(seq 1 90); do
  ready=$(timeout 5 sudo waydroid shell -- getprop sys.boot_completed 2>/dev/null | tr -d "\r") || ready=""
  if test "$ready" = 1; then break; fi
  sleep 2
done
test "$ready" = 1
echo ANDROID_LAB_WAYDROID_BOOTED
waydroid adb connect
adb wait-for-device
adb shell -n id
adb shell -n getprop ro.adb.secure
adb shell -n am start -W -a android.settings.SETTINGS
sleep 3
echo ANDROID_LAB_STORAGE_DIAGNOSTICS_BEGIN
adb shell -n ls -ldZ /sdcard /storage /storage/emulated /storage/emulated/0 /sdcard/Download || true
adb shell -n cat /proc/mounts
adb shell -n dumpsys mount
adb shell -n dumpsys user
adb shell -n ls -ld /data/local/tmp
adb shell -n "echo android-lab-file-roundtrip > /data/local/tmp/android-lab-roundtrip.txt"
adb pull /data/local/tmp/android-lab-roundtrip.txt /home/lab/android-lab-roundtrip.txt
test "$(cat /home/lab/android-lab-roundtrip.txt)" = android-lab-file-roundtrip
adb shell -n "mkdir -p /sdcard/Download; echo android-lab-shared-roundtrip > /sdcard/Download/android-lab-roundtrip.txt" || true
adb shell -n logcat -d -t 2500 | grep -Ei "fuse|vold|storage|mediaprovider|avc:|permission denied" | tail -150 || true
sudo waydroid shell -- ls -ldZ /data/media /data/media/0 /mnt/user/0 /mnt/runtime/default/emulated || true
sudo cat /var/lib/waydroid/lxc/waydroid/config
sudo cat /var/lib/waydroid/lxc/waydroid/config_session
echo ANDROID_LAB_STORAGE_DIAGNOSTICS_END
sleep 30
'
