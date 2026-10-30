ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE}

ARG OPENCODE_VERSION=1.18.16
ARG OPENCODE_ARCHIVE_SHA256=4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41

COPY opencode-linux-arm64.tar.gz /tmp/opencode-linux-arm64.tar.gz
RUN printf '%s  %s\n' "${OPENCODE_ARCHIVE_SHA256}" /tmp/opencode-linux-arm64.tar.gz | sha256sum --check --strict \
    && mkdir -p /opt/opencode \
    && tar -xzf /tmp/opencode-linux-arm64.tar.gz -C /opt/opencode \
    && test "$(/opt/opencode/opencode --version)" = "${OPENCODE_VERSION}" \
    && rm /tmp/opencode-linux-arm64.tar.gz \
    && mkdir -p /workspace/.teamaibox/home /workspace/.teamaibox/data /workspace/.teamaibox/cache \
    && chown -R 65532:65532 /workspace

COPY --chmod=0555 opencode-entrypoint.sh /usr/local/bin/teamaibox-opencode-entrypoint

ENV HOME=/workspace/.teamaibox/home \
    XDG_CONFIG_HOME=/run/teamaibox/xdg-config \
    XDG_DATA_HOME=/workspace/.teamaibox/data \
    XDG_CACHE_HOME=/workspace/.teamaibox/cache \
    OPENCODE_CONFIG=/run/teamaibox/xdg-config/opencode/opencode.json \
    OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_SHARE=1 \
    OPENCODE_AUTO_SHARE=false \
    OPENCODE_PURE=1 \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
    OPENCODE_DISABLE_EXTERNAL_SKILLS=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_EMBEDDED_WEB_UI=1 \
    OPENCODE_PERMISSION={"*":"ask"} \
    OPENCODE_SERVER_USERNAME=opencode

WORKDIR /workspace
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/teamaibox-opencode-entrypoint"]
CMD ["serve", "--hostname", "127.0.0.1", "--port", "4096"]
