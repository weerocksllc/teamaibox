# Source-build pilot only. Not registered in the appliance until identity and
# document-binding acceptance passes. Context is verified Penpot mcp/ source.
FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:932a44adcdb8f5dfbf00f00eb38da8d22b450b2ad258b6d1b2319beca823bfbd AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/pnpm/pnpm/releases/download/v12.15.0/pnpm-linux-arm64.tar.gz -o /tmp/pnpm.tar.gz \
    && echo 'd7ce93a2c7d847d3a34bd3f559b60c14f578b1320c17cc352a2c5c5fdf956117  /tmp/pnpm.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/pnpm.tar.gz -C /usr/local/bin pnpm \
    && rm /tmp/pnpm.tar.gz
ENV npm_config_manage_package_manager_versions=false npm_config_package_manager_strict=false
WORKDIR /opt/penpot/mcp
COPY . .
RUN pnpm install --frozen-lockfile && pnpm run build
# Keep the official server and browser plugin together, including the narrow
# protected-integration overlay when prepared by build_penpot_stack.py. Native
# shared libraries (sharp) must be checked before this can become a release.
FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:932a44adcdb8f5dfbf00f00eb38da8d22b450b2ad258b6d1b2319beca823bfbd
COPY --from=build --chown=node:node /opt/penpot /opt/penpot
WORKDIR /opt/penpot/mcp/packages/server
USER node
ENV PENPOT_MCP_SERVER_HOST=127.0.0.1
CMD ["node", "dist/index.js", "--multi-user"]
