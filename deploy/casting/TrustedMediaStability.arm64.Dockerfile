# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
COPY --chown=65532:65532 services/trusted_media_service/gdp_media_ingress.py services/trusted_media_service/native_receiver_process.py services/trusted_media_service/discoverable_receiver.py services/trusted_media_service/receiver_supervisor.py services/trusted_media_service/runtime_api.py /opt/teamaibox/services/trusted_media_service/
USER 65532:65532
