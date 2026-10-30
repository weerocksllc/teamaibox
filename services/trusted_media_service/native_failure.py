"""Reduce native assertions to source location only, never log native text."""
import re

FILES = ("crypto", "pairing", "raop", "raop_handlers", "raop_rtp", "raop_rtp_mirror",
         "httpd", "dnssd", "uxplay", "audio_renderer", "video_renderer",
         "gstvideorate", "gstvideoconvertscale", "gstvideodecoder", "gstgdppay", "dataprotocol",
         "gstbuffer", "gstbufferpool", "gstpad", "gstbasetransform", "gstbaseparse", "gstbasesink",
         "gstappsrc", "gstqueue", "gstsegment", "gstutils", "gstmemory", "gstallocator",
         "gstavviddec", "gsth264parse", "video-converter", "video-scaler", "video-frame",
         "video-info", "video-chroma", "video-format", "video-color", "gstvideometa")
# Ubuntu's GStreamer is built with relative source paths (../gst/...), unlike
# the absolute UxPlay build paths. Keep only a fixed source-name enum and line.
CODE = re.compile(r"^native_assert_(?:" + "|".join(x.replace('-', '_') for x in FILES) + r")_[1-9][0-9]{0,4}$")
LINE = re.compile(rb"^(?:uxplay: |ERROR:)/?(?:[A-Za-z0-9_.-]+/){0,24}(" +
                  "|".join(re.escape(x) for x in FILES).encode() + rb")\.(?:c|cpp|h):([1-9][0-9]{0,4}):[^\r\n]{0,1000}(?:Assertion|assertion)[^\r\n]{0,1000}failed")


def assertion_code(line):
    if not isinstance(line, bytes) or len(line) > 2048:
        return None
    match = LINE.match(line)
    return "native_assert_" + match[1].decode("ascii").replace('-', '_') + "_" + match[2].decode("ascii") if match else None


def native_assertion_code(value):
    return isinstance(value, str) and CODE.fullmatch(value) is not None
