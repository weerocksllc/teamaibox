ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 0:0
COPY deploy/appliance/phone-plugin-policy.mjs /opt/teamaibox/tools/phone-plugin-policy.mjs
RUN node /opt/teamaibox/tools/phone-plugin-policy.mjs
USER 1000:1000

