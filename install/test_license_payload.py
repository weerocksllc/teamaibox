from pathlib import Path
import tempfile
import unittest
from package import LEGAL_FILES, copy_legal_notices
from offline_common import InstallError


class LicensePayloadTests(unittest.TestCase):
    def test_actual_notices_are_copied_byte_for_byte(self):
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp)
            copy_legal_notices(source, destination)
            for name in LEGAL_FILES:
                self.assertEqual((source / name).read_bytes(), (destination / name).read_bytes())

    def test_missing_notices_are_not_silently_omitted(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(InstallError):
                copy_legal_notices(Path(temp), Path(temp) / 'output')


if __name__ == '__main__':
    unittest.main()
