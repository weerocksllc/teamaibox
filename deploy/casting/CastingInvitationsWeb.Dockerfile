ARG WEB_PARENT
FROM ${WEB_PARENT}
COPY --chown=0:0 dist/ /opt/teamaibox/web/
