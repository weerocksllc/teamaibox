"""Bounded installer orchestration tests; no Docker, VPN, model or guest writes."""
import hashlib
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
import os
from unittest.mock import patch
from offline_common import InstallError
from public_model_git import endpoint, pointer, metadata
from source_network import rewrite
from source_install import Pipeline, tree_inventory
from source_download import download


class SourceInstallTests(unittest.TestCase):
    def test_official_downloads_use_bounded_parallelism(self):
        from source_install import models
        with tempfile.TemporaryDirectory() as tmp, patch('fetch_public_models.fetch') as fetch:
            models(None, Path(tmp), 'https://huggingface.co')
            self.assertEqual(fetch.call_count, 6)
            self.assertTrue(all(call.kwargs['range_workers'] == 4 and call.kwargs['file_workers'] == 2
                                for call in fetch.call_args_list))
            fetch.reset_mock()
            models(None, Path(tmp), 'https://mirror.example')
            self.assertTrue(all(call.kwargs['range_workers'] == 1 and call.kwargs['file_workers'] == 1
                                for call in fetch.call_args_list))

    def test_resume_and_source_binding(self):
        with tempfile.TemporaryDirectory() as tmp:
            work=Path(tmp).resolve()/'work';target=Path(tmp).resolve()/'installation'
            count=[]
            def action(out):
                count.append(1);out.mkdir();(out/'output').write_text('fixture')
            p=Pipeline(work,'source-one',target)
            p.step('build',action);p.step('build',action)
            self.assertEqual(len(count),1)
            with self.assertRaises(RuntimeError):Pipeline(work,'source-one',target)
            p.lock.close()
            with self.assertRaises(RuntimeError):Pipeline(work,'source-two',target)

    def test_failed_attempt_retained_and_changed_output_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Pipeline(Path(tmp).resolve()/'work','source',Path(tmp).resolve()/'install')
            def fail(out):
                out.mkdir();(out/'error').write_text('retained');raise RuntimeError('interrupted')
            with self.assertRaises(RuntimeError):p.step('stage',fail)
            def succeed(out):out.mkdir();(out/'good').write_text('good')
            out=p.step('stage',succeed)
            self.assertTrue((out.parent/'1/error').exists())
            (out/'good').write_text('corrupt')
            with self.assertRaises(InstallError):p.step('stage',succeed)
            p.lock.close()

    def test_mirror_has_no_credentials_or_security_downgrade(self):
        for value in ('http://mirror.example','https://user:pass@mirror.example','https://mirror.example/a','https://mirror.example?key=value'):
            with self.assertRaises(InstallError):endpoint(value)
        sha='a'*64
        self.assertEqual(rewrite('FROM docker.io/library/node@sha256:'+sha,'https://mirror.example'),
                         'FROM mirror.example/library/node@sha256:'+sha)
        self.assertEqual(rewrite('FROM nvcr.io/nvidia/vllm@sha256:'+sha,'https://mirror.example'),
                         'FROM nvcr.io/nvidia/vllm@sha256:'+sha)
        self.assertEqual(rewrite('FROM docker.io/library/node:latest','https://mirror.example'),
                         'FROM docker.io/library/node:latest')

    def test_lfs_pointer_is_exact_and_checked(self):
        raw=b'version https://git-lfs.github.com/spec/v1\noid sha256:'+b'a'*64+b'\nsize 10\n'
        self.assertEqual(pointer(raw,'b'*40,len(raw))['lfs']['sha256'],'a'*64)
        with self.assertRaises(InstallError):pointer(raw+b'evil\n','b'*40,len(raw)+5)

    def test_git_metadata_bound_to_real_commit_not_mirror_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache=Path(tmp)
            repo='example/model';folder=cache/hashlib.sha256(repo.encode()).hexdigest()
            subprocess.run(['git','init','-q',str(folder)],check=True)
            (folder/'config.json').write_text('{}')
            (folder/'model.bin').write_text('version https://git-lfs.github.com/spec/v1\noid sha256:'+'a'*64+'\nsize 10\n')
            subprocess.run(['git','-C',str(folder),'add','.'],check=True)
            subprocess.run(['git','-C',str(folder),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],check=True)
            revision=subprocess.check_output(['git','-C',str(folder),'rev-parse','HEAD'],text=True).strip()
            # The downloader uses a bare object store, not a working checkout.
            bare=cache/'bare';subprocess.run(['git','clone','-q','--bare',str(folder),str(bare)],check=True)
            import shutil
            shutil.rmtree(folder);bare.rename(folder)
            result=metadata(repo,revision,'https://mirror.example',cache)
            self.assertEqual(result['sha'],revision)
            self.assertEqual(next(r for r in result['siblings'] if r['rfilename']=='model.bin')['size'],10)

    def test_completed_partial_needs_no_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp).resolve()/'asset';raw=b'fixture';sha=hashlib.sha256(raw).hexdigest()
            target.with_name('asset.'+sha+'.partial').write_bytes(raw)
            with patch('source_download.urlopen') as opener:
                download('https://publisher.example/file',sha,target)
                opener.assert_not_called()
            self.assertEqual(target.read_bytes(),raw)

    def test_resumed_range_checked_before_append(self):
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp).resolve()/'asset';raw=b'first-second';sha=hashlib.sha256(raw).hexdigest()
            target.with_name('asset.'+sha+'.partial').write_bytes(b'first-')
            class Response(io.BytesIO):
                status=206
                headers={'Content-Range':'bytes 6-11/12'}
                def geturl(self):return 'https://publisher.example/file'
            with patch('source_download.urlopen',return_value=Response(b'second')):
                download('https://publisher.example/file',sha,target)
            self.assertEqual(target.read_bytes(),raw)

    def test_wrong_resume_range_never_appends(self):
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp).resolve()/'asset';sha=hashlib.sha256(b'first-second').hexdigest()
            partial=target.with_name('asset.'+sha+'.partial');partial.write_bytes(b'first-')
            class Response(io.BytesIO):
                status=206
                headers={'Content-Range':'bytes 0-5/12'}
                def geturl(self):return 'https://publisher.example/file'
            with patch('source_download.urlopen',side_effect=lambda *a,**k:Response(b'second')),patch('source_download.time.sleep'):
                with self.assertRaises(InstallError):download('https://publisher.example/file',sha,target)
            self.assertEqual(partial.read_bytes(),b'first-');self.assertFalse(target.exists())

    def test_network_wrapper_has_its_import_path(self):
        from source_install import configure_network
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,os.environ.copy()):
            root=Path(tmp).resolve();fake=root/'original-docker'
            fake.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n');fake.chmod(0o755)
            with patch('source_install.shutil.which',return_value=str(fake)):
                configure_network(root,'cn',None,'https://mirror.example')
            result=subprocess.check_output([str(root/'network/bin/docker'),'image','inspect',
                'docker.io/library/node@sha256:'+'a'*64],text=True)
            self.assertIn('mirror.example/library/node@sha256:',result)


if __name__=='__main__':unittest.main()
