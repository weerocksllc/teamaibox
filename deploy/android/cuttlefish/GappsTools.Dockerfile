# Build-only tools. This image is never used to run a user phone.
ARG PHONE_BASE_IMAGE
FROM ${PHONE_BASE_IMAGE}
USER 0:0
RUN apt-get update && apt-get install -y --no-install-recommends \
    e2fsprogs erofs-utils apksigner default-jre-headless unzip python3-protobuf \
    && dpkg-query -W e2fsprogs erofs-utils apksigner default-jre-headless > /opt/gapps-tool-versions.txt \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["python3"]
