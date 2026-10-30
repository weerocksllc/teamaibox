"""Exercise the native input boundary, without starting an AirPlay receiver."""
from pathlib import Path
import shutil
import select
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("c++"), "native C++ compiler is required")
class NativePinTest(unittest.TestCase):
    def ready(self, process):
        # macOS may delay launching a newly compiled executable. Start the
        # native input deadline assertion only after entering main(), keeping
        # it separate from host loader/signature checks.
        readable, _, _ = select.select([process.stdout], [], [], 15)
        if not readable:
            process.kill()
            self.fail("native probe did not enter main")
        self.assertEqual(process.stdout.readline(), b"ready\n")

    def test_only_exact_bounded_pipe_value_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix="teamaibox-native-pin-") as directory:
            executable = Path(directory) / "probe"
            source = b'''#include "session_pin.h"
#include <stdio.h>
int main() {
  puts("ready");
  fflush(stdout);
  uint16_t value = 0;
  return teamaibox_read_session_pin(0, &value) && value == 1234 ? 0 : 64;
}
'''
            built = subprocess.run([shutil.which("c++"), "-std=c++17", "-Wall", "-Wextra", "-Werror",
                "-I", str(ROOT / "services/trusted_media_service/native"), "-x", "c++", "-", "-o", str(executable)],
                input=source, capture_output=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr.decode())
            for payload in (b"1234\n", b"", b"1234", b"0000\n", b"0123\n", b"123456\n",
                            b"1234\nextra", b"1234\r\n", b" 1234\n", b"123\x00\n", b"1234\n\n"):
                with self.subTest(payload=payload), subprocess.Popen([str(executable)], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
                    self.ready(process)
                    stdout, stderr = process.communicate(payload, timeout=4)
                    self.assertEqual(process.returncode, 0 if payload == b"1234\n" else 64)
                    self.assertEqual((stdout, stderr), (b"", b""))

            # A regular file must not turn a persisted PIN into a credential
            # source, even when its bytes happen to satisfy the wire format.
            with tempfile.TemporaryFile() as persisted:
                persisted.write(b"1234\n")
                persisted.seek(0)
                with subprocess.Popen([str(executable)], stdin=persisted,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
                    self.ready(process)
                    stdout, stderr = process.communicate(timeout=4)
                    self.assertEqual((process.returncode, stdout, stderr), (64, b"", b""))

            # Five valid-looking bytes are insufficient without EOF. Keep the
            # pipe open to exercise the total deadline, rather than a per-read
            # timeout that a slow sender could keep extending indefinitely.
            with subprocess.Popen([str(executable)], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
                self.ready(process)
                started = time.monotonic()
                process.stdin.write(b"1234\n")
                process.stdin.flush()
                self.assertEqual(process.wait(timeout=4), 64)
                process.stdin.close()
                self.assertEqual(process.stdout.read(), b"")
                self.assertEqual(process.stderr.read(), b"")
            self.assertGreaterEqual(time.monotonic() - started, 2.8)
            self.assertLess(time.monotonic() - started, 4.0)


if __name__ == "__main__":
    unittest.main()
