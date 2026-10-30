ARG BASE
FROM ${BASE}
USER root
RUN cp /opt/teamaibox/phone_runtime.py /opt/teamaibox/phone_runtime_base.py
COPY phone_camera_lifecycle_runtime.py /opt/teamaibox/phone_runtime.py
COPY phone_camera_vm_supervisor.py /opt/teamaibox/phone_camera_crosvm.py
RUN chmod 0555 /opt/teamaibox/phone_camera_crosvm.py /opt/teamaibox/phone_runtime.py /opt/teamaibox/phone_runtime_base.py
USER 10001:10001
