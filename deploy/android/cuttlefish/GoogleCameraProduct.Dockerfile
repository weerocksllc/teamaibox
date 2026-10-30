# Same camera/settings implementation as Standard Android. Only the already
# verified, account-free Google system partitions differ; no guest data copied.
ARG PHONE_BASE_IMAGE
FROM ${PHONE_BASE_IMAGE}
USER 0:0
COPY super.img vbmeta_system.img /opt/cuttlefish/
COPY google-play-experiment.json /opt/teamaibox/google-play-experiment.json
RUN chmod 0444 /opt/cuttlefish/super.img /opt/cuttlefish/vbmeta_system.img /opt/teamaibox/google-play-experiment.json
LABEL com.teamaibox.phone-system="google-play" com.teamaibox.phone-google-play="experimental-not-certified"
USER 10001:10001
