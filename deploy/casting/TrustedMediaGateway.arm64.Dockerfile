# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Cached, exact ARM64 base; no runtime dependency download in this successor.
FROM ${BUILD_PARENT_1}
COPY services/trusted_media_service /opt/teamaibox/services/trusted_media_service
COPY services/trusted_media_runtime /opt/teamaibox/services/trusted_media_runtime
ENV PYTHONPATH=/opt/teamaibox PYTHONDONTWRITEBYTECODE=1 GST_DEBUG=0
USER 65532:65532
WORKDIR /nonexistent
STOPSIGNAL SIGTERM
HEALTHCHECK NONE
ENTRYPOINT ["/usr/bin/python3", "-m", "services.trusted_media_runtime.appliance"]
LABEL org.teamaibox.claim="development-private-gateway-not-product-accepted"
