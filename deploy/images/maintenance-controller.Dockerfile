ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE}
WORKDIR /opt/teamaibox
COPY --chown=10001:10001 services/maintenance-controller ./services/maintenance-controller
COPY --chown=10001:10001 services/scheduler/src/production-protected-maintenance-signature-verifier.mjs ./services/scheduler/src/production-protected-maintenance-signature-verifier.mjs
ENV NODE_ENV=production MAINTENANCE_CONTROLLER_PORT=9446
USER 10001:10001
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "const fs=require('node:fs');require('node:https').get({host:'127.0.0.1',port:Number(process.env.MAINTENANCE_CONTROLLER_PORT||9446),path:'/health/ready',servername:process.env.MAINTENANCE_CONTROLLER_TLS_SERVER_NAME||'localhost',ca:fs.readFileSync(process.env.MAINTENANCE_CONTROLLER_CA_FILE),cert:fs.readFileSync(process.env.MAINTENANCE_CONTROLLER_TLS_CERT_FILE),key:fs.readFileSync(process.env.MAINTENANCE_CONTROLLER_TLS_KEY_FILE)},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/services/maintenance-controller/src/server.mjs"]
