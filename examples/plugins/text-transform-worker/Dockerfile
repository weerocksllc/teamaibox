ARG NODE_IMAGE
FROM ${NODE_IMAGE}

WORKDIR /workspace
COPY --chown=10001:10001 packages/plugin-sdk/ packages/plugin-sdk/
COPY --chown=10001:10001 examples/plugins/text-transform-worker/ examples/plugins/text-transform-worker/

USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=1s --timeout=2s --start-period=1s --retries=2 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "examples/plugins/text-transform-worker/src/server.mjs"]
