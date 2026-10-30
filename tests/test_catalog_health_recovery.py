"""Exercise the actual poller's SQL/error branch, without a live database."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CatalogHealthRecoveryTests(unittest.TestCase):
    def test_database_outage_clears_ready_and_next_poll_recovers(self):
        source = (ROOT / 'deploy/application-catalog-e2e/refresh-health.sh').read_text()
        block = source[source.index('  if PGCONNECT_TIMEOUT=5 psql'):source.rindex('  sleep 15')]
        with tempfile.TemporaryDirectory(prefix='catalog-health-recovery-') as folder:
            root = Path(folder)
            marker = root / 'ready'
            marker.touch()
            # Generated test executable; consumes the SQL heredoc, fails once.
            (root / 'psql').write_text('#!/bin/bash\ncat >/dev/null\nif [ ! -e "$COUNTER" ]; then touch "$COUNTER"; exit 1; fi\nexit 0\n')
            (root / 'psql').chmod(0o755)
            block = block.replace('/tmp/catalog-health-ready', str(marker))
            environment = dict(os.environ, PATH=folder + ':' + os.environ['PATH'], COUNTER=str(root / 'once'),
                               PLATFORM_DATABASE_HOST='test-only', PLATFORM_DATABASE_USER='test-only', PLATFORM_DATABASE_NAME='test-only')
            script = 'set -euo pipefail\nmodel_healthy=true; drawing_healthy=true; ocr_healthy=true; asr_healthy=true; realtime_asr_healthy=true\n'
            script += block + '\ntest ! -f "' + str(marker) + '"\n'
            script += block + '\ntest -f "' + str(marker) + '"\n'
            result = subprocess.run(['bash'], input=script, text=True, capture_output=True, env=environment, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr.count('catalog health refresh deferred'), 1)
            self.assertTrue(marker.exists())


if __name__ == '__main__':
    unittest.main()
