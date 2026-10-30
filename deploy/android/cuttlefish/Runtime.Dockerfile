# Supply the freshly built, checksum-verified bundle, never a developer image ID.
ARG BUNDLE_IMAGE
FROM ${BUNDLE_IMAGE}
USER 0:0
COPY capability_query.py /usr/lib/cuttlefish-common/bin/capability_query.py
# Convert the read-only shared system image once during assembly, not on each
# phone start. The pristine sparse userdata remains the per-phone seed.
RUN /opt/cuttlefish/bin/simg2img /opt/cuttlefish/super.img /tmp/phone-super.raw \
    && mv /tmp/phone-super.raw /opt/cuttlefish/super.img \
    && chmod 0444 /opt/cuttlefish/super.img \
    && chmod 0555 /usr/lib/cuttlefish-common/bin/capability_query.py \
    && (getent group cvdnetwork || groupadd cvdnetwork) \
    && (getent group render || groupadd render) \
    && (getent group kvm || groupadd kvm) \
    && (getent passwd 10001 || useradd --uid 10001 --no-create-home --home-dir /phone/home --shell /usr/sbin/nologin phone)
COPY phone_runtime.py /opt/teamaibox/phone_runtime.py
COPY phone_media_control.py /opt/teamaibox/phone_media_control.py
COPY phone_adb_control.py /opt/teamaibox/phone_adb_control.py
COPY phone_files.py /opt/teamaibox/phone_files.py
COPY resources.py /opt/teamaibox/media_resources.py
RUN mv /opt/cuttlefish/bin/webRTC /opt/cuttlefish/bin/webRTC.elf
COPY phone_streamer.py /opt/cuttlefish/bin/webRTC
RUN chmod 0555 /opt/cuttlefish/bin/webRTC
USER 10001:10001
WORKDIR /phone
ENV HOME="/phone/home"
ENTRYPOINT ["/usr/bin/python3", "/opt/teamaibox/phone_runtime.py"]
CMD ["serve"]
