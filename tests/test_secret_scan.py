from __future__ import annotations

import pathlib
import tempfile
import unittest

from tools.scan_secrets import scan_paths, shannon_entropy
from unittest.mock import patch


class SecretScanTests(unittest.TestCase):
    def test_repository_has_no_high_confidence_credentials(self) -> None:
        from tools.scan_secrets import all_files, repository_files

        self.assertEqual(scan_paths(repository_files()), [])
        self.assertEqual(scan_paths(all_files()), [])

    def test_detects_private_key_and_provider_token_without_echoing_value(self) -> None:
        with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as directory:
            root = pathlib.Path(directory)
            filename = root / "leak.txt"
            filename.write_text(
                "-----BEGIN " + "PRIVATE KEY-----\n"
                + "api_key = 's" + "k-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'\n",
                encoding="utf-8",
            )
            findings = scan_paths([filename], root=root)
            self.assertEqual({item["rule"] for item in findings}, {"private_key", "openai_key", "high_entropy_assignment"})
            self.assertNotIn("ABCDEFGHIJKLMNOPQRSTUVWXYZ", str(findings))

    def test_allows_short_and_explicit_test_placeholders(self) -> None:
        with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as directory:
            root = pathlib.Path(directory)
            filename = root / "fixture.txt"
            filename.write_text(
                "password = 'short-value'\n"
                "access_token = 'test-only-not-a-credential'\n",
                encoding="utf-8",
            )
            self.assertEqual(scan_paths([filename], root=root), [])

    def test_entropy_distinguishes_repetition(self) -> None:
        self.assertLess(shannon_entropy(b"aaaaaaaaaaaaaaaaaaaaaaaa"), 1.0)
        self.assertGreater(shannon_entropy(b"aB3/xY9+pQ7:zK2_mN8-rT5"), 3.5)

    def test_excluded_directories_are_pruned_before_traversal(self) -> None:
        from tools.scan_secrets import all_files
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "source.txt").write_text("ordinary source")
            (root / "node_modules").mkdir()
            (root / "node_modules" / "ignored.txt").write_text("dependency")
            (root / "linked").symlink_to(root / "node_modules", target_is_directory=True)
            def walk(*args, **kwargs):
                directories = ["node_modules", "linked"]
                yield str(root), directories, ["source.txt"]
                self.assertEqual(directories, [])
            with patch("tools.scan_secrets.os.walk", side_effect=walk):
                self.assertEqual(all_files(root), [root / "source.txt"])

    def test_pem_header_marker_is_not_material_but_escaped_pem_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / 'sample.txt'
            header = '-----BEGIN ' + 'PRIVATE KEY-----'
            path.write_text(repr(header), encoding='utf-8')
            self.assertEqual(scan_paths([path], root=root), [])
            for newline in ('\n', '\r\n', '\\n', '\\r\\n'):
                path.write_text(header + newline, encoding='utf-8')
                self.assertEqual([v['rule'] for v in scan_paths([path], root=root)], ['private_key'])


if __name__ == "__main__":
    unittest.main()
