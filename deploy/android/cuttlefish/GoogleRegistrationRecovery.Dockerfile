# Additive runtime patch only. Keep the tested guest partitions, camera, network
# and shutdown implementation; never copy a logged-in phone into a shared image.
ARG PHONE_RUNTIME_IMAGE
FROM ${PHONE_RUNTIME_IMAGE}
USER 0:0
COPY tools/inspect_phone_google_compliance.py /opt/teamaibox/phone_google_compliance.py
COPY deploy/android/cuttlefish/phone_google_recovery.py /opt/teamaibox/phone_google_recovery.py
COPY deploy/android/cuttlefish/phone_camera_browser_start.py /opt/teamaibox/phone_network_start.py
COPY deploy/android/cuttlefish/patch_phone_instance_bound.py /opt/teamaibox/patch_phone_instance_bound.py
RUN python3 /opt/teamaibox/patch_phone_instance_bound.py && python3 -m py_compile /opt/teamaibox/phone_google_compliance.py /opt/teamaibox/phone_google_recovery.py /opt/teamaibox/phone_network_start.py /opt/teamaibox/phone_runtime_base.py
USER 10001:10001
