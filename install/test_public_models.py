"""Source artifact identity and path handling only; no inference or network."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fetch_public_models import identity, selected, destination_name, runtime_file, translation_license
from offline_common import InstallError


class PublicModelTests(unittest.TestCase):
    def test_supplemental_license_requires_publisher_declaration(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); card=directory/'README.md'
            card.write_text('---\nlicense: unknown\n---\n')
            with patch('build_public_android.acquire') as acquire:
                with self.assertRaises(InstallError):
                    translation_license(directory,card)
                acquire.assert_not_called()
            card.write_text('---\nlicense: apache-2.0\n---\n')
            with patch('build_public_android.acquire') as acquire:
                translation_license(directory,card)
                acquire.assert_called_once()
            self.assertTrue((directory/'license-provenance.json').is_file())

    def test_git_and_lfs_identity(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'file'
            path.write_bytes(b'publisher fixture')
            raw = path.read_bytes()
            git = hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
            self.assertTrue(identity(path,dict(size=len(raw),blobId=git)))
            self.assertTrue(identity(path,dict(size=len(raw),lfs=dict(sha256=hashlib.sha256(raw).hexdigest()))))
            self.assertFalse(identity(path,dict(size=len(raw),blobId='0'*40)))
            link=Path(root)/'link';link.symlink_to(path)
            self.assertFalse(identity(link,dict(size=len(raw),blobId=git)))

    def test_ocr_layout_and_unsafe_paths(self):
        self.assertEqual(destination_name('ocr-model','a'*40,'dflash/config.json'),'hunyuanocr-dflash/config.json')
        self.assertTrue(destination_name('ocr-model','a'*40,'model.safetensors').endswith('/snapshots/'+'a'*40+'/model.safetensors'))
        for path in ('../token.json','/root/token.json','.git/config','images/example.png'):
            if path.startswith(('../','/')):
                with self.assertRaises(InstallError): selected(path)
            else: self.assertFalse(selected(path))
        self.assertTrue(selected('LICENSE'))
        self.assertFalse(selected('.env'))
        self.assertFalse(runtime_file('drawing-model','flux-2-klein-4b.safetensors'))
        self.assertTrue(runtime_file('drawing-model','transformer/diffusion_pytorch_model.safetensors'))
        self.assertFalse(runtime_file('ocr-model','v1.0/model.safetensors'))
        self.assertTrue(runtime_file('ocr-model','dflash/model.safetensors'))


if __name__=='__main__': unittest.main()
