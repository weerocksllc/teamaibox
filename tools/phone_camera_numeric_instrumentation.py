"""Appended only to the fixed module in a bounded, exact test container.
Numeric pipeline diagnostics only. Never writes frames, SDP or device names.
"""
from collections import deque
import json as _diag_json
from pathlib import Path as _DiagPath

_UninstrumentedCameraReceiver = BrowserCameraReceiver

class BrowserCameraReceiver(_UninstrumentedCameraReceiver):
    def __init__(self, **kwargs):
        self._diag_ages=deque(maxlen=240);self._diag_decode=deque(maxlen=240)
        self._diag_delivery=deque(maxlen=240);self._diag_times=deque(maxlen=240)
        self._diag_count=0;self._diag_caps={}
        super().__init__(**kwargs)
        iterator=self._video.iterate_elements()
        while True:
            result,element=iterator.next()
            if result!=self.Gst.IteratorResult.OK:break
            if element.get_factory().get_name()=='vp8dec':
                element.get_static_pad('src').add_probe(self.Gst.PadProbeType.BUFFER,self._diag_decoded)
    def _diag_age(self, buffer):
        if buffer is None or buffer.pts==self.Gst.CLOCK_TIME_NONE:return None
        clock=self._pipeline.get_clock()
        return (clock.get_time()-self._pipeline.get_base_time()-buffer.pts)/1e6 if clock else None
    def _diag_decoded(self,pad,info):
        try:
            age=self._diag_age(info.get_buffer())
            if age is not None:self._diag_decode.append(age)
            caps=pad.get_current_caps()
            if caps and caps.get_size()==1:
                s=caps.get_structure(0)
                self._diag_caps={k:s.get_value(k) for k in ('width','height') if s.has_field(k)}
                # get_value(GstFraction) is unsupported by the shipped GI
                # binding. A numeric observer must never discard media.
                if s.has_field('pixel-aspect-ratio'):
                    ok,numerator,denominator=s.get_fraction('pixel-aspect-ratio')
                    self._diag_caps['pixelAspectRatio']=[numerator,denominator] if ok else None
        except Exception:
            self._diag_caps['measurementError']=True
        return self.Gst.PadProbeReturn.OK
    def _sample(self,sink):
        # appsink's last PTS is visible via the sample before the original
        # callback pulls it; use a pad probe instead for final JPEG age.
        at=time.monotonic();result=super()._sample(sink)
        self._diag_delivery.append((time.monotonic()-at)*1000);self._diag_times.append(at);self._diag_count+=1
        if self._diag_count%30==0:
            try:self._diag_write()
            except Exception:pass
        return result
    def _pad_added(self,element,pad):
        super()._pad_added(element,pad)
        if self._linked:
            def final(_pad,info):
                try:
                    age=self._diag_age(info.get_buffer())
                    if age is not None:self._diag_ages.append(age)
                except Exception:pass
                return self.Gst.PadProbeReturn.OK
            self._sink.get_static_pad('sink').add_probe(self.Gst.PadProbeType.BUFFER,final)
    def _diag_write(self):
        def stats(values):
            v=sorted(values)
            return None if not v else dict(samples=len(v),min=v[0],median=v[len(v)//2],p95=v[int((len(v)-1)*.95)],max=v[-1])
        t=list(self._diag_times)
        value=dict(frames=self._diag_count,inputCaps=self._diag_caps,decodedAgeMs=stats(self._diag_decode),
                   jpegAgeMs=stats(self._diag_ages),deliveryMs=stats(self._diag_delivery),
                   outputFps=(len(t)-1)/(t[-1]-t[0]) if len(t)>1 else None,personalContentRecorded=False)
        _DiagPath('/tmp/phone-camera-numeric.json').write_text(_diag_json.dumps(value))
