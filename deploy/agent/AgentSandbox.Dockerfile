ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE}

ARG OPENCODE_VERSION=1.18.16
ARG OPENCODE_ARCHIVE_SHA256=4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41

ADD --checksum=sha256:4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41 \
    https://github.com/anomalyco/opencode/releases/download/v1.18.16/opencode-linux-arm64.tar.gz \
    /tmp/opencode-linux-arm64.tar.gz
RUN printf '%s  %s\n' "${OPENCODE_ARCHIVE_SHA256}" /tmp/opencode-linux-arm64.tar.gz | sha256sum --check --strict \
    && mkdir -p /opt/opencode \
    && tar -xzf /tmp/opencode-linux-arm64.tar.gz -C /opt/opencode \
    && test "$(/opt/opencode/opencode --version)" = "${OPENCODE_VERSION}" \
    && rm /tmp/opencode-linux-arm64.tar.gz

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/teamaibox
COPY --chown=65532:65532 packages/observability ./packages/observability
COPY --chown=65532:65532 services/agent-bridge ./services/agent-bridge
COPY --chown=65532:65532 services/object-service/src/buffered-media-budget.mjs ./services/object-service/src/buffered-media-budget.mjs
COPY --chown=65532:65532 deploy/agent/opencode-bridge-main.mjs ./validation/opencode-bridge-main.mjs
COPY --chown=65532:65532 deploy/agent/opencode-agent-sandbox-main.mjs ./validation/opencode-agent-sandbox-main.mjs
COPY --chown=0:0 deploy/agent/teamaibox-package-proof.sh /usr/local/bin/teamaibox-package-proof
RUN chmod 0555 /usr/local/bin/teamaibox-package-proof

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
    PIP_CONFIG_FILE=/run/teamaibox/source-config/pip.conf \
    PIP_INDEX_URL=http://source-gateway:8080/pip/simple/ \
    PIP_EXTRA_INDEX_URL= \
    PIP_TRUSTED_HOST=source-gateway \
    NPM_CONFIG_USERCONFIG=/run/teamaibox/source-config/npmrc \
    NPM_CONFIG_REGISTRY=http://source-gateway:8080/npm/registry/ \
    APT_CONFIG=/run/teamaibox/source-config/apt/apt.conf \
    TEAMAIBOX_APT_PROXY_URL=http://source-gateway:8080/apt

WORKDIR /workspace
USER 65532:65532
EXPOSE 4097
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4097/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/validation/opencode-agent-sandbox-main.mjs"]
