ARG PHONE_BASE_IMAGE
FROM ${PHONE_BASE_IMAGE}
USER 0:0
COPY phone_*.py /opt/teamaibox/
RUN cp /opt/teamaibox/phone_runtime.py /opt/teamaibox/phone_runtime_base.py \
 && cp /opt/teamaibox/phone_network_start.py /opt/teamaibox/phone_network_base.py \
 && cp /opt/teamaibox/phone_camera_crosvm.py /opt/teamaibox/phone_camera_crosvm_base.py
COPY phone_camera_lifecycle_runtime.py /opt/teamaibox/phone_runtime.py
COPY phone_camera_vm_supervisor.py /opt/teamaibox/phone_camera_crosvm.py
COPY phone_camera_browser_start.py /opt/teamaibox/phone_network_start.py
COPY resources.py /opt/teamaibox/media_resources.py
COPY inspect_phone_google_compliance.py /opt/teamaibox/phone_google_compliance.py
COPY vhu_media_v4l2_stream_proxy crosvm libgfxstream_backend.so /opt/teamaibox/camera-host/bin/
COPY camera-decoder.whl camera-decoder.lock.json install_phone_camera_decoder.py /tmp/camera-build/
RUN python3 /tmp/camera-build/install_phone_camera_decoder.py \
 && python3 -c "import sys;sys.path.insert(0,'/opt/teamaibox/camera-python');from PIL import Image;Image.new('RGB',(640,480),(40,40,40)).save('/opt/teamaibox/camera-neutral.jpg',quality=85,progressive=False)" \
 && chmod 0555 /opt/teamaibox/camera-host/bin/crosvm /opt/teamaibox/camera-host/bin/vhu_media_v4l2_stream_proxy /opt/teamaibox/phone_camera_crosvm.py \
 && chmod 0444 /opt/teamaibox/camera-neutral.jpg \
 && /opt/teamaibox/camera-host/bin/vhu_media_v4l2_stream_proxy --help \
 && /opt/teamaibox/camera-host/bin/crosvm --help \
 && python3 -m compileall -q /opt/teamaibox
LABEL org.opencontainers.image.source="https://github.com/weerocksllc/teamaibox" \
      com.teamaibox.phone-camera="image-browser-video-usb-udp" \
      com.teamaibox.phone-system="standard"
ENTRYPOINT ["/usr/bin/python3", "/opt/teamaibox/phone_network_start.py"]
CMD ["serve"]
