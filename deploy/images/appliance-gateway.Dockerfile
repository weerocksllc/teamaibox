ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE}

ARG IMAGE_REVISION=unknown
LABEL org.opencontainers.image.title="Team AI Box Appliance Gateway" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      com.teamaibox.architecture="linux/arm64/v8" \
      com.teamaibox.privileged-boundary="appliance-loopback-mtls"

WORKDIR /opt/teamaibox
COPY --chown=10006:10006 packages/authorization ./packages/authorization
COPY --chown=10006:10006 services/appliance-gateway ./services/appliance-gateway

ENV NODE_ENV=production APPLIANCE_GATEWAY_HOST=127.0.0.1 APPLIANCE_GATEWAY_PORT=9444
USER 10006:10006
EXPOSE 9444
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=6 \
  CMD ["node", "-e", "require('node:https').get({host:'127.0.0.1',port:9444,path:'/health/ready',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/teamaibox/services/appliance-gateway/server/main.mjs"]

