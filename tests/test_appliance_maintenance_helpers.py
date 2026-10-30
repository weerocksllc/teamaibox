"""Local-only contracts for retained maintenance primitives; no commands run."""
import hashlib
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools import appliance_database as database
from tools import appliance_operations as operations
from tools import ci_database_smoke as smoke


class ApplianceMaintenanceHelperTests(unittest.TestCase):
    def test_digest_format_retains_existing_evidence_contract(self):
        value = {'z': '中文', 'a': [1, True]}
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(',', ':')).encode()
        expected = 'sha256:' + hashlib.sha256(raw).hexdigest()
        self.assertEqual(operations.canonical_digest(value), expected)
        self.assertEqual(operations.digest_bytes(raw), expected)

    def test_database_queries_are_bounded_before_any_command(self):
        with patch.object(database.REMOTE, 'run') as run:
            for query in ('', 'x' * (512 * 1024 + 1), '中' * (512 * 1024)):
                with self.assertRaises(database.DeploymentError):
                    database.remote_psql(query)
            run.assert_not_called()

    def test_database_command_failures_do_not_return_payload(self):
        with patch.object(database.REMOTE, 'run',
                          return_value=SimpleNamespace(returncode=1, stdout='private')):
            with self.assertRaisesRegex(database.DeploymentError, '^retained PostgreSQL operation failed$'):
                database.remote_psql('SELECT 1')

    def test_snapshot_anchors_cover_every_historical_table(self):
        query = database.snapshot_expression("before'quote")
        self.assertIn("'before''quote|'", query)
        for table in database.HISTORICAL_TABLES:
            self.assertIn('FROM ' + table + ' item', query)
        self.assertEqual(query.count(' AS row_hash '), len(database.HISTORICAL_TABLES))
        self.assertIn("'anchorMd5',anchor", query)

    def test_smoke_manifest_references_only_present_current_tests(self):
        self.assertTrue(all(path.is_file() for path in smoke.SMOKE_FILES))
        self.assertIn('casting_viewer_lifetime_smoke.sql', {p.name for p in smoke.SMOKE_FILES})
        self.assertFalse(any('fleet' in p.name or 'managed_node' in p.name for p in smoke.SMOKE_FILES))

    def test_down_migrations_hold_locks_until_atomic_commit(self):
        source = 'LOCK TABLE platform.cast_sessions IN ACCESS EXCLUSIVE MODE;'
        transaction = smoke.down_transaction(source)
        self.assertTrue(transaction.startswith('BEGIN;\n'))
        self.assertTrue(transaction.endswith('\nCOMMIT;\n'))
        self.assertIn("SET LOCAL lock_timeout = '10s';", transaction)
        self.assertIn("SET LOCAL statement_timeout = '120s';", transaction)
        self.assertLess(transaction.index('BEGIN;'), transaction.index(source))


if __name__ == '__main__':
    unittest.main()
