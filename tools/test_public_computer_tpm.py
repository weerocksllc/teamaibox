"""Regression checks for the public ARM Windows runtime build contract."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PublicComputerTpmTests(unittest.TestCase):
    def test_public_build_preserves_original_qemu_version_and_signature_check(self):
        public = (ROOT / 'deploy/windows-computer/Public.Dockerfile').read_text()
        original = (ROOT / 'deploy/windows-arm64-ppi/Dockerfile').read_text()
        version = next(line for line in original.splitlines() if line.startswith('ARG QEMU_VERSION='))
        self.assertIn(version, public)
        self.assertIn('gpg --batch --verify /qemu.tar.xz.sig /qemu.tar.xz', public)
        self.assertIn('--enable-tpm', public)
        self.assertIn('--enable-pa', public)
        self.assertIn('--enable-kvm', public)

    def test_final_image_checks_ppi_and_audio_after_installing_built_qemu(self):
        public = (ROOT / 'deploy/windows-computer/Public.Dockerfile').read_text()
        final = public.rsplit('FROM runtime-base\n', 1)[1]
        binary = final.index('/usr/local/bin/qemu-system-aarch64')
        self.assertGreater(final.index('RUN qemu-system-aarch64 -device tpm-tis-device,help'), binary)
        self.assertGreater(final.index('QEMU PulseAudio backend is missing'), binary)
        self.assertIn('/usr/share/qemu/vgabios-ramfb.bin', final)
        self.assertIn('/usr/local/bin/probe-ppi', final)


if __name__ == '__main__':
    unittest.main()
