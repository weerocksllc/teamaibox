# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
COPY --chown=65532:65532 services/trusted_media_service/receiver_supervisor.py services/trusted_media_service/runtime_api.py services/trusted_media_service/media_progress.py /opt/teamaibox/services/trusted_media_service/
COPY --chown=65532:65532 services/trusted_media_service/tls_runtime_server.py /opt/teamaibox/services/trusted_media_service/
COPY --chown=65532:65532 services/trusted_media_runtime/sfu_gateway.py /opt/teamaibox/services/trusted_media_runtime/
USER 65532:65532
