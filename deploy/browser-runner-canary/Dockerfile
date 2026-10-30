FROM docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f
WORKDIR /opt/canary
COPY server.mjs state-service.mjs migrate.mjs ./
USER 10001:10001
CMD ["node", "server.mjs"]
