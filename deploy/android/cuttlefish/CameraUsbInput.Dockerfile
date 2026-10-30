ARG BASE
FROM ${BASE}
USER root
RUN python3 -c "from pathlib import Path; import shutil; p=Path('/opt/teamaibox/phone_runtime.py'); b=p.with_name('phone_runtime_base.py'); assert not p.is_symlink() and not b.is_symlink(); assert not b.exists() or ('import phone_runtime_base as base' in p.read_text() and 'from phone_runtime_base import *' in p.read_text()); shutil.copyfile(p,b) if not b.exists() else None"
COPY --chown=0:0 phone_camera_lifecycle_runtime.py /opt/teamaibox/phone_runtime.py
COPY --chown=0:0 phone_usb_camera_devices.py phone_usb_camera_fd.py phone_usb_camera_fd_source.py phone_usb_camera_session.py phone_usb_camera_worker.py phone_usb_camera_control.py /opt/teamaibox/
COPY --chown=0:0 phone_camera_client.py phone_video_camera_worker.py phone_video_camera_control.py phone_video_camera_session.py /opt/teamaibox/
COPY --chown=0:0 phone_camera_vm_supervisor.py /opt/teamaibox/phone_camera_crosvm.py
RUN chmod 0555 /opt/teamaibox/phone_camera_crosvm.py /opt/teamaibox/phone_runtime.py /opt/teamaibox/phone_runtime_base.py
USER 10001:10001
