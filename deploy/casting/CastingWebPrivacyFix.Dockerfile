ARG WEB_PARENT
FROM ${WEB_PARENT}
COPY --chown=1000:1000 apps/web/server/web-boundary.mjs /opt/teamaibox/server/web-boundary.mjs
