"""Only previously uncovered source-install protection/cache acceptance cases."""
import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from offline_common import InstallError
from public_model_git import metadata
from source_download import download
from source_install import protect_existing_install


class RemainingSourceChecks(unittest.TestCase):
    def test_existing_install_is_preserved_before_downloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp)/'installation';target.mkdir()
            sentinel=target/'existing-data';sentinel.write_bytes(b'preserve')
            for state in ({},{'package':'prior-package'}):
                with self.assertRaises(InstallError):protect_existing_install(target,state)
                self.assertEqual(sentinel.read_bytes(),b'preserve')
            (target/'install-state.json').write_text('{}')
            with self.assertRaises(InstallError):protect_existing_install(target,{})
            protect_existing_install(target,{'package':'prior-package'})
            self.assertEqual(sentinel.read_bytes(),b'preserve')

    def test_portable_cache_is_rechecked_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();original=root/'export';original.mkdir()
            raw=b'public input fixture';sha=hashlib.sha256(raw).hexdigest()
            (original/'asset').write_bytes(raw)
            copied=root/'import';shutil.copytree(original,copied)
            with patch('source_download.urlopen') as network:
                download('https://publisher.example/asset',sha,copied/'asset')
                network.assert_not_called()
                (copied/'asset').write_bytes(b'altered')
                with self.assertRaises(InstallError):download('https://publisher.example/asset',sha,copied/'asset')
                network.assert_not_called()

    def test_corrupt_cached_git_metadata_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source';repo='fixture/model'
            subprocess.run(['git','init','-q',str(source)],check=True)
            (source/'config.json').write_text('{}')
            subprocess.run(['git','-C',str(source),'add','.'],check=True)
            subprocess.run(['git','-C',str(source),'-c','user.name=Fixture','-c',
                            'user.email=fixture@example.invalid','commit','-qm','fixture'],check=True)
            revision=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
            blob=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD:config.json'],text=True).strip()
            cache=root/'cache';store=cache/hashlib.sha256(repo.encode()).hexdigest()
            subprocess.run(['git','clone','-q','--bare',str(source),str(store)],check=True)
            obj=store/'objects'/blob[:2]/blob[2:]
            obj.chmod(0o600);obj.write_bytes(b'corrupt git object')
            with self.assertRaises(subprocess.CalledProcessError):
                metadata(repo,revision,'https://publisher.example',cache)


if __name__=='__main__':unittest.main()
