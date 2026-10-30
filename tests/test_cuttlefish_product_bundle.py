"""Offline assembly safety, using small archives; not an Android boot test."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FOLDER = ROOT / "deploy/android/cuttlefish"
SPEC = importlib.util.spec_from_file_location("cuttlefish_product_bundle", FOLDER / "prepare_bundle.py")
BUNDLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUNDLE)


class BundleTests(unittest.TestCase):
    def test_fixed_sources_and_no_boot_network_install_or_browser_layer(self):
        lock = json.loads((FOLDER / "inputs.lock.json").read_text())
        self.assertEqual(lock["buildId"], "16102939")
        self.assertEqual(lock["firstProfile"]["memoryLimitBytes"], 6*1024**3)
        self.assertEqual(lock["firstProfile"]["memorySwapLimitBytes"], 6*1024**3)
        self.assertTrue(lock["firstProfile"]["modemSimulator"])
        self.assertEqual(lock["firstProfile"]["googlePlay"], "deferred")
        source = (FOLDER / "Dockerfile").read_text()
        self.assertIn("FROM " + lock["dependencyImageId"] + " AS dependencies", source)
        self.assertNotIn("apt-get", source)
        self.assertNotIn("curl ", source)
        self.assertNotIn("--headless", source)
        self.assertIn('ENTRYPOINT ["/usr/bin/python3", "/opt/teamaibox/bundle_info.py"]', source)

    def test_archive_paths_reject_traversal(self):
        for value in ("../outside", "a/../../outside", "/etc/passwd", "a\\b", "a\0b", ""):
            with self.subTest(value=value), self.assertRaises(ValueError): BUNDLE.archive_path(value)
        self.assertEqual(str(BUNDLE.archive_path("./bin/launch_cvd")), "bin/launch_cvd")

    def test_host_filter_excludes_test_tree_and_rejects_escaping_links(self):
        with tempfile.TemporaryDirectory(prefix="phone-bundle-test-") as directory:
            root = Path(directory); archive = root / "host.tar.gz"; target = root / "out"; target.mkdir()
            with tarfile.open(archive, "w:gz") as stream:
                item = tarfile.TarInfo("./"); item.type=tarfile.DIRTYPE; stream.addfile(item)
                for name in ("bin/launch_cvd", "nativetest64/test", "test-phone/userdata.img"):
                    item = tarfile.TarInfo(name); item.size = 2
                    stream.addfile(item, io.BytesIO(b"ok"))
            BUNDLE.extract_host(archive, target)
            self.assertEqual((target / "bin/launch_cvd").read_bytes(), b"ok")
            self.assertFalse((target / "test-phone").exists()); self.assertFalse((target / "nativetest64").exists())
            with tarfile.open(archive, "w:gz") as stream:
                item = tarfile.TarInfo("bin/escape"); item.type = tarfile.SYMTYPE; item.linkname = "../../outside"
                stream.addfile(item)
            with self.assertRaises(tarfile.FilterError): BUNDLE.extract_host(archive, target)
            self.assertFalse((root / "outside").exists())

    def test_guest_rejects_missing_nested_duplicate_and_linked_data(self):
        with tempfile.TemporaryDirectory(prefix="phone-bundle-test-") as directory:
            root = Path(directory); archive = root / "guest.zip"; target = root / "out"; target.mkdir()
            with zipfile.ZipFile(archive, "w") as stream:
                for name in BUNDLE.REQUIRED_GUEST: stream.writestr(name,b"official-fixture")
            BUNDLE.extract_guest(archive,target)
            self.assertEqual((target / "userdata.img").read_bytes(),b"official-fixture")
            for name in ("other-phone/userdata.img", "../../escape", "unexpected.txt"):
                with zipfile.ZipFile(archive,"w") as stream: stream.writestr(name,b"bad")
                with self.assertRaises(ValueError): BUNDLE.extract_guest(archive,target)
            with zipfile.ZipFile(archive,"w") as stream: stream.writestr("boot.img",b"incomplete")
            with self.assertRaises(ValueError): BUNDLE.extract_guest(archive,target)
            with zipfile.ZipFile(archive,"w") as stream:
                member=zipfile.ZipInfo("userdata.img"); member.external_attr=0o120777<<16
                stream.writestr(member,"../../outside")
            with self.assertRaises(ValueError): BUNDLE.extract_guest(archive,target)

    def test_changed_input_rejected_before_creating_output(self):
        with tempfile.TemporaryDirectory(prefix="phone-bundle-test-") as directory:
            root=Path(directory); target=root / "out"
            (root / "cvd-host_package.tar.gz").write_bytes(b"wrong-build")
            with self.assertRaises(ValueError): BUNDLE.assemble(root,target,FOLDER / "inputs.lock.json")
            self.assertFalse(target.exists())
            with self.assertRaises(ValueError): BUNDLE.localize_assets(root,root / "cvd-host_package.tar.gz")


if __name__ == "__main__": unittest.main()
