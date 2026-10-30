ARG PHONE_BASE_IMAGE
FROM ${PHONE_BASE_IMAGE}
USER 0:0
COPY super.img vbmeta_system.img vbmeta_vendor_dlkm.img /opt/cuttlefish/
RUN chmod 0444 /opt/cuttlefish/super.img /opt/cuttlefish/vbmeta_system.img /opt/cuttlefish/vbmeta_vendor_dlkm.img
