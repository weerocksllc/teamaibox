"""Progress reports transfer, not premature verification; no real downloads."""
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from fetch_public_models import range_download


class TransferProgressTests(unittest.TestCase):
    def test_completed_cached_range_reports_unverified_receipt(self):
        raw=b'synthetic transfer fixture'
        sha=hashlib.sha256(raw).hexdigest()
        row={'size':len(raw),'rfilename':'fixture.bin','lfs':{'sha256':sha}}
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/sha).mkdir();(root/sha/'0').write_bytes(raw)
            destination=io.BytesIO();messages=io.StringIO()
            with patch('fetch_public_models.urlopen') as network, redirect_stdout(messages):
                range_download('https://publisher.example/fixture',row,root,destination,workers=1)
            network.assert_not_called()
            self.assertEqual(destination.getvalue(),raw)
            self.assertIn(f'received {len(raw)}/{len(raw)} bytes',messages.getvalue())
            self.assertIn('hash verification pending',messages.getvalue())


if __name__=='__main__':unittest.main()
