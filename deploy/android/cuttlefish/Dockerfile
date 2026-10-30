# syntax=docker/dockerfile:1
# Built from Dependencies.Dockerfile by install/build_public_android.py.
ARG DEPENDENCY_IMAGE
FROM ${DEPENDENCY_IMAGE} AS dependencies

FROM dependencies AS bundle
COPY inputs /build/inputs
COPY inputs.lock.json prepare_bundle.py /build/
RUN python3 /build/prepare_bundle.py --inputs /build/inputs --output /bundle --lock /build/inputs.lock.json

# Copy only the dependency filesystem and the freshly verified base archive.
# No lab image metadata, guest writable overlays, test APKs, Chrome/CDP or /lab
# volume contents become the final phone image. Bundle assembly is offline.
FROM scratch
COPY --from=dependencies / /
COPY --from=bundle /bundle /opt/cuttlefish
COPY bundle_info.py /opt/teamaibox/bundle_info.py
ENV PATH="/opt/cuttlefish/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV ANDROID_HOST_OUT="/opt/cuttlefish" ANDROID_PRODUCT_OUT="/opt/cuttlefish"
LABEL org.opencontainers.image.title="Team AI Box Cuttlefish product bundle" \
      org.opencontainers.image.version="16102939-aosp17-arm64-v1" \
      com.teamaibox.workload.kind="android-phone" \
      com.teamaibox.android.build="16102939"
USER 10001:10001
WORKDIR /opt/cuttlefish
# No implicit VM boot, server, network listener or host-volume allocation. Node
# Agent integration supplies the separate fixed lifecycle entry point in 3.2/3.4.
ENTRYPOINT ["/usr/bin/python3", "/opt/teamaibox/bundle_info.py"]
