# The caller must inspect and bind the exact local ARM64 parent image ID before
# building offline. Do not pull a mutable replacement or deploy this unqualified.
ARG TRUSTED_MEDIA_PARENT
FROM ${TRUSTED_MEDIA_PARENT}
COPY services/trusted_media_service/runtime_composition.py services/trusted_media_service/runtime_api.py services/trusted_media_service/receiver_supervisor.py services/trusted_media_service/output_readiness.py services/trusted_media_service/tls_runtime_server.py /opt/teamaibox/services/trusted_media_service/
COPY services/trusted_media_runtime/main.py /opt/teamaibox/services/trusted_media_runtime/main.py
ENV PYTHONPATH=/opt/teamaibox PYTHONDONTWRITEBYTECODE=1 NVIDIA_VISIBLE_DEVICES=void NVIDIA_DRIVER_CAPABILITIES=""
USER 65532:65532
WORKDIR /nonexistent
STOPSIGNAL SIGTERM
HEALTHCHECK NONE
ENTRYPOINT ["/usr/bin/python3", "-m", "services.trusted_media_runtime.appliance"]
LABEL org.teamaibox.claim="browser-only-candidate-not-product-accepted"
