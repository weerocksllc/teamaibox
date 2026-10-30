"""GDB-only GLib assertion probe: compiler location, never expression/media."""
import gdb
import json
import os
import re


def code_string(register):
    address = int(gdb.parse_and_eval(register))
    if not address:
        return None
    data = bytearray()
    for offset in range(256):
        byte = bytes(gdb.selected_inferior().read_memory(address + offset, 1))
        if byte == b'\0':
            return data.decode('ascii', errors='strict')
        data.extend(byte)
    return None


class CompilerLocation(gdb.Breakpoint):
    def stop(self):
        try:
            # g_assertion_message_expr(domain, file, line, function, expression)
            # AArch64 ABI. Never inspect domain, expression, locals or buffers.
            if gdb.newest_frame().architecture().name() != 'aarch64':
                return False
            path = code_string('$x1')
            filename = os.path.basename(path or '')
            line = int(gdb.parse_and_eval('$x2'))
            allowed = re.fullmatch(r'(?:gst[a-z0-9_-]+|video-[a-z0-9_-]+|probe)\.c', filename)
            if allowed and 0 < line < 100000:
                print('SAFE_ASSERT:' + json.dumps(dict(file=filename, line=line)))
        except Exception:
            print('SAFE_ASSERT:' + json.dumps(dict(locationUnavailable=True)))
        return False


probe = CompilerLocation('g_assertion_message_expr', internal=True)
probe.silent = True


def signal_stop(event):
    if isinstance(event, gdb.SignalEvent) and re.fullmatch(r'SIG[A-Z0-9]{1,12}', event.stop_signal):
        print('SAFE_STOP:' + json.dumps(dict(signal=event.stop_signal)))


gdb.events.stop.connect(signal_stop)
