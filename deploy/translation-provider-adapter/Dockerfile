FROM scratch

ARG RUN_UID=1000
ARG RUN_GID=1000

COPY translation-provider-adapter /translation-provider-adapter

USER ${RUN_UID}:${RUN_GID}
EXPOSE 9443
ENTRYPOINT ["/translation-provider-adapter"]
