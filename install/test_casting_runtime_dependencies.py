"""Focused public casting-image dependency contract; no appliance operations."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CastingRuntimeDependencyTests(unittest.TestCase):
    def test_discovery_uses_the_unprivileged_service_identity(self):
        dockerfile = (ROOT / 'deploy/casting/Public.Dockerfile').read_text()
        self.assertIn('groupmod --non-unique --gid 65532 avahi', dockerfile)
        self.assertIn('usermod --non-unique --uid 65532 --gid 65532 avahi', dockerfile)
        self.assertIn('USER 65532:65532', dockerfile)

    def test_final_runtime_installs_discovery_daemon_not_only_client_library(self):
        dockerfile = (ROOT / 'deploy/casting/Public.Dockerfile').read_text()
        final = dockerfile.rsplit('FROM ${UBUNTU_IMAGE}\n', 1)[1]
        packages = final.split('apt-get install -y --no-install-recommends', 1)[1].split('&&', 1)[0].split()
        self.assertIn('avahi-daemon', packages)
        self.assertIn('dbus', packages)

    def test_final_image_checks_executables_used_by_receiver(self):
        dockerfile = (ROOT / 'deploy/casting/Public.Dockerfile').read_text()
        final = dockerfile.rsplit('FROM ${UBUNTU_IMAGE}\n', 1)[1]
        for executable in ('/usr/bin/uxplay', '/usr/bin/dbus-daemon',
                           '/usr/bin/dbus-send', '/usr/sbin/avahi-daemon'):
            self.assertIn('test -x ' + executable, final)
        self.assertIn('gst-inspect-1.0 "$element"', final)
        self.assertIn('|| exit 1', final)

    def test_webrtc_transport_is_installed_and_checked_not_just_the_sink(self):
        dockerfile = (ROOT / 'deploy/casting/Public.Dockerfile').read_text()
        final = dockerfile.rsplit('FROM ${UBUNTU_IMAGE}\n', 1)[1]
        packages = final.split('apt-get install -y --no-install-recommends', 1)[1].split('&&', 1)[0].split()
        self.assertIn('gstreamer1.0-nice', packages)
        checks = final.split('for element in ', 1)[1].split('; do', 1)[0].split()
        for element in ('livekitwebrtcsink', 'webrtcbin', 'nicesrc', 'nicesink',
                        'dtlssrtpenc', 'dtlssrtpdec', 'sctpenc', 'sctpdec', 'rtpbin'):
            self.assertIn(element, checks)


if __name__ == '__main__':
    unittest.main()
