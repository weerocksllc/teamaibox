"""Build content-free HDMI signal counters on the exact deployed image."""
import prepare_casting_hdmi_timing_runtime as base
base.RUN='casting-hdmi-signal-runtime-20260909-a1'
base.IMAGE='teamaibox/trusted-media-service:hdmi-signal-20260909-a1'
base.PARENT='sha256:5638956dd4d4c3250837bd52488fd8fd4e03d2897211afec3a8986ffb1d5e82b'
base.PARENT_TAG='teamaibox/trusted-media-service:hdmi-timing-20260909-a1'
base.PARENT_EVIDENCE='evidence/validation/supply-chain/casting-hdmi-timing-runtime-20260909-a1.json'
base.CHANGED=tuple('services/trusted_media_service/'+n+'.py' for n in ('audio_signal_meter','hdmi_media_output','media_progress'))
base.DF='deploy/casting/TrustedMediaHdmiSignal.arm64.Dockerfile'
SOURCES=(*base.CHANGED,base.DF,'tools/prepare_casting_hdmi_signal_runtime.py',
         'tools/prepare_casting_hdmi_timing_runtime.py','tests/test_trusted_media_audio_signal.py')
base.SOURCES=SOURCES
if __name__=='__main__':raise SystemExit(base.main())
