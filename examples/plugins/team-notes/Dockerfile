ARG NODE_IMAGE
FROM ${NODE_IMAGE}

ARG PLUGIN_VERSION=1.0.0
ARG PLUGIN_HEALTH=ready
ENV TEAMAIBOX_PLUGIN_VERSION=${PLUGIN_VERSION}
ENV TEAMAIBOX_PLUGIN_HEALTH=${PLUGIN_HEALTH}

WORKDIR /workspace
COPY --chown=10001:10001 packages/plugin-sdk/ packages/plugin-sdk/
COPY --chown=10001:10001 examples/plugins/team-notes/ examples/plugins/team-notes/

USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=1s --timeout=2s --start-period=1s --retries=2 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "examples/plugins/team-notes/src/server.mjs"]
