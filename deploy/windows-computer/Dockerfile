# Build tooling supplies the exact tested ARM64 QEMU/firmware runtime image.
# No dependency download and no host driver/kernel changes in this successor.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY runtime.py /opt/teamaibox/windows_runtime.py
COPY runtime.py /opt/teamaibox/runtime.py
COPY optical_drive.py /opt/teamaibox/optical_drive.py
COPY optical_client.py /opt/teamaibox/optical_client.py
COPY inspect_iso.py /opt/teamaibox/inspect_iso.py
COPY installation_boot.py /opt/teamaibox/installation_boot.py
COPY probe.py /opt/teamaibox/probe.py
ENTRYPOINT ["python3", "/opt/teamaibox/windows_runtime.py"]
CMD ["serve"]
