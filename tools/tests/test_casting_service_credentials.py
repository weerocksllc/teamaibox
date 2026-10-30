import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("casting_service_credentials", ROOT / "tools/casting_service_credentials.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CredentialRestoreTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix="casting-identity-test-")
        self.root = Path(self.fixture.name).resolve()
        self.uid = os.geteuid()
        self.volume = self.root / "volume" / "mount"
        self.volume.mkdir(parents=True, mode=0o700)
        self.destination = self.root / "run"
        self.destination.mkdir(mode=0o711)
        self.destination.chmod(0o711)
        self.generation = "casting-service-20260908-a1"
        self.source = self.volume / "service-identities" / self.generation
        self.source.mkdir(parents=True, mode=0o700)
        self.source.parent.chmod(0o700)
        self.plan = dict(schemaVersion=1, generation=self.generation, source=str(self.source),
            destination=str(self.destination / self.generation), encryptedVolume=dict(mount=str(self.volume),
                mapper="test-only-casting", filesystemUuid="11111111-1111-4111-8111-111111111111",
                luksUuid="22222222-2222-4222-8222-222222222222"))
        self.destinations = {section:self.uid or uid for section,(uid,_) in module.FILES.items()}
        self.make_bundle()
        self.override = patch.object(module, "DESTINATION", self.destination)
        self.override.start()
        self.ownership = []
        if self.uid != 0:
            # Non-root macOS unit tests retain the current group. The separate
            # root Linux/container test exercises the real service UID/GIDs.
            for name in ("chown", "fchown"):
                original=getattr(os,name)
                replacement=patch.object(module.os,name,side_effect=lambda path,uid,gid,original=original: original(path,uid,os.getegid()))
                replacement.start();self.ownership.append(replacement)

    def tearDown(self):
        self.override.stop()
        for replacement in self.ownership: replacement.stop()
        for section in module.FILES:
            folder = self.destination / self.generation / section
            if folder.is_dir() and not folder.is_symlink(): folder.chmod(0o700)
        self.fixture.cleanup()

    def make_bundle(self):
        files = {}
        for section,(_,names) in module.FILES.items():
            folder = self.source / section
            folder.mkdir(mode=0o700)
            for name in names:
                raw = ("synthetic-service-identity:" + section + "/" + name).encode()
                path = folder / name
                path.write_bytes(raw); path.chmod(0o600)
                files[f"{section}/{name}"] = module.digest(raw)
        self.manifest = dict(schemaVersion=1, generation=self.generation, files=files)
        self.write_manifest()

    def write_manifest(self):
        path = self.source / "bundle.json"
        path.write_text(json.dumps(self.manifest)); path.chmod(0o600)

    def restore(self, **kwargs):
        return module.restore(self.plan, source_check=kwargs.pop("source_check", lambda _:None),
            tmpfs_check=kwargs.pop("tmpfs_check", lambda _:None), owner=self.uid,
            destinations=self.destinations, **kwargs)

    def test_restore_only_allowlisted_services_and_repeat_without_overwrite(self):
        first = self.restore()
        self.assertFalse(first["alreadyPresent"])
        self.assertFalse(first["sessionRestored"])
        self.assertFalse(first["serviceStarted"])
        target = self.destination / self.generation
        inodes = {}
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o711)
        for section,(_,names) in module.FILES.items():
            self.assertEqual(stat.S_IMODE((target/section).stat().st_mode), 0o500)
            self.assertEqual((target/section).stat().st_uid, self.destinations[section])
            for name in names:
                path = target / section / name
                self.assertEqual(path.read_bytes(), (self.source / section / name).read_bytes())
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o400)
                self.assertEqual(path.stat().st_uid, self.destinations[section])
                inodes[str(path)] = path.stat().st_ino
        self.assertTrue(self.restore()["alreadyPresent"])
        self.assertEqual(inodes, {path:Path(path).stat().st_ino for path in inodes})

    def test_encryption_or_tmpfs_absence_fails_before_any_secret_read(self):
        def reject(_): raise module.CredentialError()
        for checks in ({"source_check":reject}, {"tmpfs_check":reject}):
            with patch.object(module, "load_bundle", side_effect=AssertionError("must not read")):
                with self.assertRaises(module.CredentialError): self.restore(**checks)
            self.assertEqual(list(self.destination.iterdir()), [])

    def test_reject_path_escape_wrong_generation_unknown_or_session_file(self):
        for section,name in (("media","receiver-pin"),("platform","viewer-token"),("sfu","media.mp4")):
            path=self.source/section/name
            path.write_bytes(b"synthetic-forbidden");path.chmod(0o600)
            with self.assertRaises(module.CredentialError): self.restore()
            path.unlink()
        self.manifest["files"]["media/../session.key"] = "sha256:"+"a"*64
        self.write_manifest()
        with self.assertRaises(module.CredentialError): self.restore()
        self.assertEqual(list(self.destination.iterdir()), [])
        for key,value in (("destination","/"),("source",str(self.root)),("generation","../escape")):
            bad={**self.plan,key:value}
            with self.assertRaises(module.CredentialError): module.validate_plan(bad)

    def test_duplicate_keys_file_tamper_and_open_permissions_rejected(self):
        path=self.source/"bundle.json"
        path.write_text('{"schemaVersion":1,"schemaVersion":1}')
        with self.assertRaises(module.CredentialError): self.restore()
        self.write_manifest()
        identity=self.source/"media/media-server.key"
        identity.write_bytes(b"changed")
        with self.assertRaises(module.CredentialError): self.restore()
        self.manifest["files"]["media/media-server.key"]=module.digest(identity.read_bytes());self.write_manifest()
        identity.chmod(0o644)
        with self.assertRaises(module.CredentialError): self.restore()
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_reject_symbolic_links_hard_links_fifo_and_large_inputs(self):
        path=self.source/"media/media-server.key"
        original=path.read_bytes();path.unlink()
        for shape in ("symlink","hardlink","fifo","oversized"):
            if shape=="symlink": path.symlink_to(self.source/"media/media-client.key")
            elif shape=="hardlink": os.link(self.source/"media/media-client.key",path)
            elif shape=="fifo": os.mkfifo(path,0o600)
            else: path.write_bytes(b"x"*(module.MAX_FILE+1));path.chmod(0o600)
            with self.assertRaises((module.CredentialError,OSError)): self.restore()
            path.unlink()
        path.write_bytes(original);path.chmod(0o600)
        self.restore()

    def test_existing_generation_drift_is_not_overwritten(self):
        self.restore()
        target=self.destination/self.generation/"media/media-server.key"
        original=target.read_bytes()
        target.chmod(0o600);target.write_bytes(b"retain-do-not-overwrite");target.chmod(0o400)
        with self.assertRaises(module.CredentialError): self.restore()
        self.assertEqual(target.read_bytes(),b"retain-do-not-overwrite")
        target.chmod(0o600);target.write_bytes(original);target.chmod(0o400)
        self.assertTrue(self.restore()["alreadyPresent"])

    def test_partial_write_failure_removes_only_own_temporary_files(self):
        unrelated=self.destination/"unrelated-generation"
        unrelated.mkdir(mode=0o700)
        (unrelated/"keep").write_bytes(b"keep")
        original=os.write;count=0
        def fail(fd,data):
            nonlocal count
            count+=1
            if count==3: raise OSError("synthetic-disk-failure")
            return original(fd,data)
        with patch.object(module.os,"write",side_effect=fail):
            with self.assertRaises(OSError): self.restore()
        self.assertEqual(list(self.destination.iterdir()),[unrelated])
        self.assertEqual((unrelated/"keep").read_bytes(),b"keep")

    def test_source_guard_checks_exact_luks2_mapper_and_never_mutates_it(self):
        commands=[]
        def output(args):
            commands.append(args)
            if args[0]=="findmnt": return json.dumps({"filesystems":[dict(source="/dev/mapper/test-only-casting",
                target=str(self.volume),fstype="ext4",uuid=self.plan["encryptedVolume"]["filesystemUuid"],options="rw,nodev,nosuid")]})
            if args[1]=="status": return "/dev/mapper/test-only-casting is active\n  type: LUKS2\n  device: /dev/loop7"
            if args[1]=="luksUUID": return self.plan["encryptedVolume"]["luksUuid"]
            raise AssertionError("unexpected command")
        with patch.object(module,"secure_directory",side_effect=lambda path,**_:Path(path)),patch.object(module,"command",side_effect=output):
            module.require_encrypted_source(self.plan)
        self.assertEqual([args[:2] for args in commands], [["findmnt","-J"],["cryptsetup","status"],["cryptsetup","luksUUID"]])
        for old,new in (("LUKS2","PLAIN"),("/dev/mapper/test-only-casting","/dev/sda"),
                        (self.plan["encryptedVolume"]["luksUuid"],"00000000-0000-4000-8000-000000000000")):
            with patch.object(module,"secure_directory",side_effect=lambda path,**_:Path(path)),patch.object(module,"command",side_effect=lambda args:output(args).replace(old,new)):
                with self.assertRaises(module.CredentialError): module.require_encrypted_source(self.plan)


if __name__ == "__main__": unittest.main()
