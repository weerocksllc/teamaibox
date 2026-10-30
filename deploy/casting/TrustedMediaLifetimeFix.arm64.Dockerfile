# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Exact parent manifest is checked by the release runner before deployment.
FROM ${BUILD_PARENT_1}
COPY --chown=65532:65532 services/trusted_media_service/service_child_process.py services/trusted_media_service/private_discovery.py services/trusted_media_service/native_receiver_process.py services/trusted_media_service/runtime_api.py /opt/teamaibox/services/trusted_media_service/
USER 65532:65532
LABEL org.teamaibox.claim="development-browser-service-not-product-accepted"
