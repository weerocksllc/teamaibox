"""Prove the process-local one-sender binding, without claiming Apple acceptance."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("cc"), "native C compiler is required")
class PairedPeerTest(unittest.TestCase):
    def test_only_first_authenticated_peer_can_own_session(self):
        source = r'''
#include "paired_peer.h"
#include <stdatomic.h>
#define CHECK(x) do { if (!(x)) return __LINE__; } while (0)
static teamaibox_paired_peer_t peer;
static atomic_int winners;
static void *claim(void *value) {
    unsigned char key[32] = {0};
    key[0] = (unsigned char)(uintptr_t)value;
    if (teamaibox_paired_peer_approve(&peer, key)) atomic_fetch_add(&winners, 1);
    return NULL;
}
int main(void) {
    CHECK(teamaibox_paired_peer_init(&peer));
    unsigned char key[32] = {1}, other[32] = {2};
    CHECK(!teamaibox_paired_peer_allows(&peer, key));
    CHECK(!teamaibox_paired_peer_allows(NULL, key));
    CHECK(!teamaibox_paired_peer_approve(&peer, NULL));
    CHECK(teamaibox_paired_peer_approve(&peer, key));
    CHECK(teamaibox_paired_peer_allows(&peer, key));
    CHECK(teamaibox_paired_peer_approve(&peer, key));
    CHECK(!teamaibox_paired_peer_approve(&peer, other));
    CHECK(!teamaibox_paired_peer_allows(&peer, other));
    teamaibox_paired_peer_destroy(&peer);
    CHECK(!peer.approved && peer.key[0] == 0);
    CHECK(teamaibox_paired_peer_init(&peer));
    CHECK(!teamaibox_paired_peer_allows(&peer, key));
    pthread_t senders[32];
    for (uintptr_t i=0; i<32; ++i) CHECK(pthread_create(&senders[i], NULL, claim, (void *)(i+1)) == 0);
    for (int i=0; i<32; ++i) CHECK(pthread_join(senders[i], NULL) == 0);
    CHECK(atomic_load(&winners) == 1);
    teamaibox_paired_peer_destroy(&peer);
    return 0;
}
'''
        with tempfile.TemporaryDirectory(prefix="teamaibox-paired-peer-") as directory:
            executable = Path(directory) / "probe"
            result = subprocess.run([shutil.which("cc"), "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread",
                "-I", str(ROOT / "services/trusted_media_service/native"), "-x", "c", "-", "-o", str(executable)],
                input=source.encode(), capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            result = subprocess.run([str(executable)], capture_output=True, timeout=5)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))


if __name__ == "__main__":
    unittest.main()
