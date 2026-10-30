# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Private service candidate only: resource admission and final release minimum
# must be validated before Platform casting availability may become ready.
# Preflight binds local base config sha256:28e5d4a53f0337d9a793c6758d9d12c71e093d76fe017820c7b460f0d2938ce1.
FROM ${BUILD_PARENT_1}
COPY services/trusted_media_runtime /opt/teamaibox/services/trusted_media_runtime
ENV PYTHONPATH=/opt/teamaibox PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
WORKDIR /nonexistent
STOPSIGNAL SIGTERM
# The inherited PID-only UxPlay check does not represent daemon readiness.
HEALTHCHECK NONE
ENTRYPOINT ["/usr/bin/python3", "-m", "services.trusted_media_runtime.main"]
LABEL org.teamaibox.claim="development-private-runtime-not-product-accepted"
