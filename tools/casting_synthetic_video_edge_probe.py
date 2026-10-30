"""No network or user media: bounded raw-video timing/geometry regression."""
import sys
import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstApp', '1.0')
from gi.repository import Gst as G, GstApp
G.init(None)

mode = sys.argv[1]
w, h = (641, 479) if mode == 'odd' else (480, 640) if mode == 'portrait' else (640, 480)
fmt = 'Y444_10LE' if mode == '10bit' else 'Y444'
rate = '0/1' if mode in ('variable', 'no-duration', 'duplicate') else '60/1'
par = '10/11' if mode == 'par' else '1/1'
pipe = G.parse_launch(f'appsrc name=input format=time caps="video/x-raw,format={fmt},width={w},height={h},framerate={rate},pixel-aspect-ratio={par}" ! videoconvert ! videorate drop-only=true max-rate=30 ! video/x-raw,format=I420,framerate=30/1 ! videoscale ! gdppay ! appsink name=output sync=false')
src, out = pipe.get_by_name('input'), pipe.get_by_name('output')
pipe.set_state(G.State.PLAYING)
received = 0
for i in range(10):
    size = ((w * (2 if fmt == 'Y444_10LE' else 1) + 3) // 4 * 4) * h * 3
    b = G.Buffer.new_allocate(None, size, None)
    b.memset(0, 0, size)
    b.pts = (i // 2 if mode == 'duplicate' else i) * G.SECOND // 60
    b.duration = G.CLOCK_TIME_NONE if mode in ('no-duration', 'variable') else G.SECOND // 60
    assert src.emit('push-buffer', b) == G.FlowReturn.OK
    s = out.try_pull_sample(50 * G.MSECOND)
    if s is not None: received += s.get_buffer().get_size()
src.emit('end-of-stream')
for _ in range(20):
    s = out.try_pull_sample(50 * G.MSECOND)
    if s is not None: received += s.get_buffer().get_size()
    elif out.is_eos(): break
error = pipe.get_bus().pop_filtered(G.MessageType.ERROR)
pipe.set_state(G.State.NULL)
assert error is None and received > w * h
print(f'synthetic_mode={mode} output_bytes={received}')
