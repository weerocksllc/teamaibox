# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
ARG BUILD_PARENT_2
FROM ${BUILD_PARENT_1} AS native
FROM ${BUILD_PARENT_2}
COPY --from=native --chmod=0555 /uxplay /usr/bin/uxplay
COPY deploy/casting/uxplay-video-geometry.patch /usr/share/teamaibox/source/patches/
COPY deploy/casting/NativeGeometry.arm64.Dockerfile /usr/share/teamaibox/source/build/
COPY services/trusted_media_service/native_receiver_process.py services/trusted_media_service/video_geometry.py services/trusted_media_service/media_progress.py services/trusted_media_service/gdp_media_ingress.py services/trusted_media_service/receiver_supervisor.py /opt/teamaibox/services/trusted_media_service/
COPY services/trusted_media_service/discoverable_receiver.py /opt/teamaibox/services/trusted_media_service/
