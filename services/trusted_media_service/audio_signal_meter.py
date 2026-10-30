"""Bounded in-memory signal-presence counters; never retain audio or a waveform."""
from array import array
import sys
from threading import Lock


class AudioSignalMeter:
    def __init__(self):
        self._lock = Lock()
        self._signal = self._silent = self._invalid = 0

    def observe_s16le(self, data):
        # The HDMI capsfilter fixes S16LE stereo/48 kHz before this meter.
        # A malformed or unexpectedly large buffer is not inspected/retained.
        if not data or len(data) % 4 or len(data) > 48000 * 2 * 2:
            with self._lock:
                self._invalid += 1
            return
        values = array('h', data)
        if sys.byteorder != 'little':
            values.byteswap()
        # Ignore sub -60 dBFS numerical noise. No level, content, filename or
        # timing history is exported, only whether each block had a signal.
        signal = any(value >= 33 or value <= -33 for value in values)
        del values
        with self._lock:
            self._signal += int(signal)
            self._silent += int(not signal)

    def snapshot(self):
        with self._lock:
            return {'signalBuffers': self._signal, 'silentBuffers': self._silent,
                    'invalidBuffers': self._invalid}
