#!/usr/bin/env python3
"""Offline synthetic RTP regression; never reads a camera or phone data.

Run inside the ARM64 phone image. A burst of fragmented VP8 RTP must survive
decoding before latency policy may drop complete raw frames. Compare hashes
to a no-drop decode of exactly the same synthetic encoded packets.
"""
import hashlib
import json
import threading
import time
from phone_browser_camera import RTP_DECODE_CHAIN

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst
Gst.init(None)

OLD = ('queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! '
       'rtpvp8depay ! vp8dec threads=1 ! ')
FIXED = RTP_DECODE_CHAIN


def finish(pipeline, timeout=25):
    message = pipeline.get_bus().timed_pop_filtered(
        timeout * Gst.SECOND, Gst.MessageType.ERROR | Gst.MessageType.EOS)
    if message is None:
        raise RuntimeError('synthetic_pipeline_timeout')
    if message.type == Gst.MessageType.ERROR:
        err, _ = message.parse_error()
        raise RuntimeError('synthetic_pipeline_error:' + err.message)


def encode(pattern):
    packets = []
    pipeline = Gst.parse_launch(
        'videotestsrc num-buffers=60 pattern=' + pattern + ' ! '
        'video/x-raw,format=I420,width=640,height=480,framerate=15/1 ! '
        'vp8enc deadline=1 cpu-used=8 threads=1 target-bitrate=3000000 keyframe-max-dist=15 ! '
        'rtpvp8pay mtu=300 pt=96 ! appsink name=packets emit-signals=true sync=false')
    def sample(sink):
        data = sink.emit('pull-sample').get_buffer()
        packets.append((data.extract_dup(0, data.get_size()), data.pts, data.duration))
        return Gst.FlowReturn.OK
    pipeline.get_by_name('packets').connect('new-sample', sample)
    try:
        pipeline.set_state(Gst.State.PLAYING)
        finish(pipeline)
        assert len(packets) > 120, 'fixture_must_fragment_frames'
        assert sum(len(p[0]) for p in packets) < 16 * 1024 * 1024
        return packets
    finally:
        pipeline.set_state(Gst.State.NULL)


def decode(packets, path, slow):
    hashes = []
    counts = {'depayPackets': 0, 'queueOverruns': 0}
    pipeline = Gst.parse_launch(
        'appsrc name=packets is-live=false block=true max-bytes=65536 format=time '
        'caps="application/x-rtp,media=video,encoding-name=VP8,payload=96,clock-rate=90000" ! '
        + path + 'videoconvert ! video/x-raw,format=I420 ! '
        'appsink name=decoded emit-signals=true sync=false max-buffers=1 drop=true')
    source = pipeline.get_by_name('packets')
    it = pipeline.iterate_elements()
    while True:
        status, element = it.next()
        if status != Gst.IteratorResult.OK:
            break
        factory = element.get_factory()
        if factory and factory.get_name() == 'rtpvp8depay':
            def packet(*_):
                counts['depayPackets'] += 1
                return Gst.PadProbeReturn.OK
            element.get_static_pad('sink').add_probe(Gst.PadProbeType.BUFFER, packet)
        if factory and factory.get_name() == 'queue':
            def overrun(*_):
                counts['queueOverruns'] += 1
            element.connect('overrun', overrun)
    def sample(sink):
        data = sink.emit('pull-sample').get_buffer()
        hashes.append(hashlib.sha256(data.extract_dup(0, data.get_size())).hexdigest())
        if slow:
            time.sleep(.08)
        return Gst.FlowReturn.OK
    pipeline.get_by_name('decoded').connect('new-sample', sample)
    failures = []
    def push():
        try:
            for data, pts, duration in packets:
                b = Gst.Buffer.new_allocate(None, len(data), None)
                b.fill(0, data)
                b.pts, b.duration = pts, duration
                if source.emit('push-buffer', b) != Gst.FlowReturn.OK:
                    raise RuntimeError('synthetic_push_failed')
                # Frame packets arrive together; the next frame is separate.
                if data[1] & 0x80:
                    time.sleep(.004)
            source.emit('end-of-stream')
        except Exception as exc:
            failures.append(type(exc).__name__)
    thread = threading.Thread(target=push, daemon=True)
    try:
        pipeline.set_state(Gst.State.PLAYING)
        thread.start()
        finish(pipeline)
        thread.join(2)
        assert not thread.is_alive() and not failures
        return dict(hashes=hashes, **counts)
    finally:
        pipeline.set_state(Gst.State.NULL)


def main():
    reports = []
    for pattern in ('smpte', 'snow'):
        packets = encode(pattern)
        reference = decode(packets, 'rtpvp8depay ! vp8dec threads=1 ! ', False)
        assert len(reference['hashes']) == 60, 'reference_incomplete'
        known = set(reference['hashes'])
        variants = {}
        for name, path in (('old', OLD), ('fixed', FIXED)):
            value = decode(packets, path, True)
            hashes = value.pop('hashes')
            variants[name] = dict(**value, frames=len(hashes),
                corruptFrames=sum(h not in known for h in hashes),
                lostRtpPackets=len(packets)-value['depayPackets'])
        assert variants['old']['lostRtpPackets'] > 0, 'old_bug_not_reproduced'
        assert variants['fixed']['lostRtpPackets'] == 0, 'fixed_lost_compressed_packets'
        assert variants['fixed']['corruptFrames'] == 0, 'fixed_corrupt_picture'
        assert variants['fixed']['frames'] >= 3, 'fixed_no_useful_frames'
        assert variants['fixed']['queueOverruns'] > 0, 'raw_frame_pressure_not_exercised'
        reports.append(dict(pattern=pattern, rtpPackets=len(packets), referenceFrames=60, **variants))
    print(json.dumps(dict(status='passed', syntheticOnly=True, gstVersion=Gst.version_string(), results=reports)))


if __name__ == '__main__':
    main()
