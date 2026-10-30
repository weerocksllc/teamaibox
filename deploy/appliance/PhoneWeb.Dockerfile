ARG WEB_PARENT
FROM ${WEB_PARENT}
COPY --chown=1000:1000 web/ /opt/teamaibox/phone-web/

