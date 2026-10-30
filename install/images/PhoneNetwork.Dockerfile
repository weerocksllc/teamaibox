ARG BASE_IMAGE
FROM ${BASE_IMAGE}
# Preserve each clean ROM and camera/Google integration; align only the host
# network adapter with the current Agent's private control-network contract.
COPY --chown=0:0 --chmod=0444 phone_network.py /opt/teamaibox/phone_network.py
