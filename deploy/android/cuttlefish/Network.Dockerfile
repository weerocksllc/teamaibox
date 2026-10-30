# Supplied by the public source builder after Runtime.Dockerfile succeeds.
ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}
COPY phone_runtime.py phone_network.py phone_network_start.py /opt/teamaibox/
# Root is used only by the network init stage in this phone's private namespace.
# It irreversibly drops to 10001 with no capabilities before starting Cuttlefish.
USER 0:0
ENTRYPOINT ["/usr/bin/python3", "/opt/teamaibox/phone_network_start.py"]
CMD ["serve"]
