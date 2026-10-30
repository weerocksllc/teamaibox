"""Native fixed-size SETUP copying; no Apple-device acceptance claim."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

@unittest.skipUnless(shutil.which("cc"), "native C compiler is required")
class SetupSecretTest(unittest.TestCase):
    def test_wrong_length_or_type_cannot_read_or_overwrite_key_material(self):
        source = r'''
#include "setup_secret.h"
#define CHECK(x) do { if (!(x)) return __LINE__; } while (0)
int main(void) {
    unsigned char input[72], output[74], sentinel[74];
    memset(input, 0x42, sizeof(input));
    memset(output, 0xAA, sizeof(output));
    memcpy(sentinel, output, sizeof(output));
    uint64_t invalid[] = {0,1,15,17,71,73,UINT64_MAX};
    for (size_t i=0; i<sizeof(invalid)/sizeof(invalid[0]); ++i) {
        CHECK(!teamaibox_copy_setup_secret(output+1,16,input,invalid[i]));
        CHECK(!teamaibox_copy_setup_secret(output+1,72,input,invalid[i]));
        CHECK(memcmp(output,sentinel,sizeof(output)) == 0);
    }
    CHECK(!teamaibox_copy_setup_secret(output,16,NULL,16));
    CHECK(!teamaibox_copy_setup_secret(NULL,16,input,16));
    CHECK(!teamaibox_copy_setup_secret(output,17,input,17));
    CHECK(teamaibox_copy_setup_secret(output+1,16,input,16));
    CHECK(output[0] == 0xAA && output[17] == 0xAA && memcmp(output+1,input,16) == 0);
    CHECK(teamaibox_copy_setup_secret(output+1,72,input,72));
    CHECK(output[0] == 0xAA && output[73] == 0xAA && memcmp(output+1,input,72) == 0);
    return 0;
}
'''
        with tempfile.TemporaryDirectory(prefix="teamaibox-setup-secret-") as directory:
            executable = Path(directory) / "probe"
            result = subprocess.run([shutil.which("cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-I", str(ROOT / "services/trusted_media_service/native"), "-x", "c", "-", "-o", str(executable)],
                input=source.encode(), capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            result = subprocess.run([str(executable)], capture_output=True, timeout=15)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))

if __name__ == "__main__": unittest.main()
