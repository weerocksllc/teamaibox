"""Offline source-only successor for negotiated HDMI audio/video latency."""
import prepare_casting_hdmi_timing_runtime as base
base.RUN='casting-hdmi-latency-runtime-20260909-a2'
base.IMAGE='teamaibox/trusted-media-service:hdmi-latency-20260909-a2'
base.PARENT='sha256:8600a9cca6d52d39de6d78f31e53b24f26915fca0ce495771ec71c6fb3865767'
base.PARENT_TAG='teamaibox/trusted-media-service:hdmi-signal-20260909-a1'
base.PARENT_EVIDENCE='evidence/validation/supply-chain/casting-hdmi-signal-runtime-20260909-a1.json'
base.CHANGED=('services/trusted_media_service/hdmi_media_output.py',)
base.DF='deploy/casting/TrustedMediaHdmiLatency.arm64.Dockerfile'
SOURCES=(*base.CHANGED,base.DF,'tools/prepare_casting_hdmi_latency_runtime.py',
         'tools/prepare_casting_hdmi_timing_runtime.py','tests/test_trusted_media_hdmi_latency.py',
         'tests/test_trusted_media_hdmi_output.py')
base.SOURCES=SOURCES
if __name__=='__main__':raise SystemExit(base.main())
