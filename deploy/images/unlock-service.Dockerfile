ARG NODE_IMAGE=docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
FROM ${NODE_IMAGE}
WORKDIR /opt/teamaibox/unlock-service
COPY --chown=1000:1000 services/unlock-service/package.json ./package.json
COPY --chown=1000:1000 services/unlock-service/src ./src
COPY --chown=1000:1000 services/unlock-service/server ./server
COPY --chown=1000:1000 services/unlock-service/public ./public
USER 1000:1000
EXPOSE 8443
ENTRYPOINT ["node", "server/main.mjs"]
