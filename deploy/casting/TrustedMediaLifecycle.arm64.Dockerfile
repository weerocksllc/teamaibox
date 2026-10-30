# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
ARG BUILD_PARENT_2
FROM ${BUILD_PARENT_1} AS native
FROM ${BUILD_PARENT_2}
COPY --from=native --chmod=0555 /uxplay /usr/bin/uxplay
COPY services/trusted_media_service/native_receiver_process.py services/trusted_media_service/discoverable_receiver.py services/trusted_media_service/media_progress.py services/trusted_media_service/receiver_supervisor.py services/trusted_media_service/display_lease_client.py services/trusted_media_service/hdmi_media_output.py services/trusted_media_service/output_readiness.py services/trusted_media_service/runtime_composition.py /opt/teamaibox/services/trusted_media_service/
COPY services/trusted_media_runtime/main.py /opt/teamaibox/services/trusted_media_runtime/
COPY deploy/casting/uxplay-source-lifecycle.patch /usr/share/teamaibox/source/patches/
COPY deploy/casting/NativeLifecycle.arm64.Dockerfile deploy/casting/TrustedMediaLifecycle.arm64.Dockerfile /usr/share/teamaibox/source/build/
