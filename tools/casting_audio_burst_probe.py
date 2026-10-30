"""Synthetic-only GDP audio burst probe; never opens a receiver or network."""
import json
import os
import time
from services.trusted_media_service.gdp_media_ingress import GdpMediaIngress, _gstreamer

Gst = _gstreamer()
vr, vw = os.pipe()
ar, aw = os.pipe()
ingress = GdpMediaIngress(video_fd=vr, audio_fd=ar)
pipeline = Gst.parse_launch('appsrc name=feed is-live=true format=time ! gdppay ! fdsink sync=false fd='+str(aw))
source = pipeline.get_by_name('feed')
source.set_property('caps', Gst.Caps.from_string('audio/x-raw,format=S16LE,rate=44100,channels=2,layout=interleaved'))
pipeline.set_state(Gst.State.PLAYING)
received = sent = 0
frame_ns = 352 * Gst.SECOND // 44100
next_burst = time.monotonic()
try:
    while sent < 400 or time.monotonic() < next_burst + .12:
        now = time.monotonic()
        if sent < 400 and now >= next_burst:
            for _ in range(4):
                buffer = Gst.Buffer.new_allocate(None, 352*4, None)
                buffer.memset(0, 0, buffer.get_size())
                buffer.pts, buffer.duration = sent*frame_ns, frame_ns
                assert source.emit('push-buffer', buffer) == Gst.FlowReturn.OK
                sent += 1
            next_burst += 4 * frame_ns / Gst.SECOND
        for _ in range(2):
            if ingress.pull('audio', timeout_ms=0) is None:
                break
            received += 1
        time.sleep(.005)
    sink=ingress._tracks['audio']['sink']
    counters={k:sink.get_property(k) for k in ('in','out','dropped','current-level-buffers') if sink.find_property(k)}
    print(json.dumps(dict(syntheticOnly=True, sentBuffers=sent, receivedBuffers=received,
                         lostBuffers=sent-received, appsink=counters)))
finally:
    ingress.close()
    pipeline.set_state(Gst.State.NULL)
    for fd in (vr,vw,ar,aw): os.close(fd)
