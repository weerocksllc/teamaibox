"""Bounded installer orchestration tests; no Docker, VPN, model or guest writes."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
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
    def test_standard_entry_installs_the_same_complete_product_with_or_without_legacy_flag(self):
        import source_install as source
        from factory_recipe import assemble, readiness
        from factory_penpot import PENPOT_IMAGE_ROLES, selected_features
        read_text=Path.read_text
        for flags in ([], ['--with-penpot'], ['--build-only']):
            with self.subTest(flags=flags), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp).resolve();target=root/'installed';work=root/'work';bundle=root/'bundle'
                bundle.mkdir()
                def build(p, cache, origin, *, make_archive):
                    self.assertEqual(p.state['features'],['penpot'])
                    self.assertEqual(make_archive,'--build-only' in flags)
                    recipe=assemble(source.ROOT,penpot=selected_features(p.state['features']))
                    templates={row['output']:row['value'] for row in recipe['templates']}
                    catalog=templates['config/application-catalog.json']
                    self.assertIn('official.penpot',catalog['requiredApplications'])
                    app=next(row['manifest'] for row in catalog['applications'] if row['manifest']['id']=='official.penpot')
                    self.assertEqual(app['entryPoints']['web']['path'],'/api/v1/design/editor/')
                    self.assertTrue(PENPOT_IMAGE_ROLES <= {row['role'] for row in readiness(recipe)})
                    controller=templates['config/agent-controller.json']
                    self.assertEqual(controller['penpot']['mcpOrigin'],'http://penpot-mcp:4401')
                    self.assertEqual(controller['image'],'@@IMAGE.agent-sandbox@@')
                    release=bundle/'release.json'
                    release.write_text(json.dumps({'features':p.state['features']}))
                    return bundle if make_archive else release
                with patch.object(sys,'argv',['source_install.py','--work-dir',str(work),'--installation-root',str(target),*flags]), \
                     patch('source_install.platform.system',return_value='Linux'), patch('source_install.platform.machine',return_value='aarch64'), \
                     patch('source_install.os.geteuid',return_value=0), patch.dict(os.environ), \
                     patch('source_install.shutil.which',return_value='/usr/bin/docker'), \
                     patch.object(Path,'read_text',autospec=True,side_effect=lambda p,*a,**kw:
                         'VERSION_ID="24.04"' if p==Path('/etc/os-release') else read_text(p,*a,**kw)), \
                     patch('source_install.check_source_host') as host, \
                     patch('source_install.configure_network',return_value='https://huggingface.co'), \
                     patch('source_install.source_identity',return_value='fixture'), patch('source_install.build',side_effect=build), \
                     patch('installer.install_source') as execute:
                    source.main()
                    host.assert_called_once_with(allow_pull=True)
                if '--build-only' in flags:
                    execute.assert_not_called()
                    self.assertNotIn('package',json.loads((work/'state.json').read_text()))
                else:
                    execute.assert_called_once_with(bundle/'release.json',source.ROOT,target)

    def test_standard_entry_rejects_a_legacy_package_without_design(self):
        from source_install import product_bundle
        with tempfile.TemporaryDirectory() as tmp:
            bundle=Path(tmp)
            (bundle/'release.json').write_text('{"features": []}')
            with self.assertRaisesRegex(InstallError,'integrated Design'):
                product_bundle(bundle)

    def test_source_host_requires_real_gpu_access_not_a_runtime_name(self):
        from source_install import check_source_host
        facts=dict(platform='linux',architecture='aarch64',uid=0,os='ubuntu:24.04',compose='2.40.0',
                   gpu='NVIDIA GB10',kvm=True,timestamp=1800000000,
                   docker={'OSType':'linux','Architecture':'aarch64','Runtimes':{'runc':{}}})
        with patch('installer.host_facts',return_value=facts), \
             patch('installer.local_probe_image',return_value='sha256:'+'a'*64), \
             patch('installer.verify_container_gpu',return_value='nvidia-device-requests') as probe:
            self.assertEqual(check_source_host(), 'nvidia-device-requests')
            probe.assert_called_once_with('sha256:'+'a'*64)
            probe.side_effect = InstallError('Docker NVIDIA GPU probe failed')
            facts['docker']['Runtimes']['nvidia']={}
            with self.assertRaisesRegex(InstallError,'GPU probe failed'):
                check_source_host()

    def test_missing_probe_image_is_reported_in_check_and_pulled_for_install(self):
        from source_install import check_source_host
        from source_toolchain import UBUNTU
        image = 'sha256:'+'a'*64
        with patch('installer.host_facts'), patch('installer.validate_host_facts'), \
             patch('installer.local_probe_image',side_effect=[None,None,image]), \
             patch('installer.verify_container_gpu',return_value='nvidia-device-requests') as probe, \
             patch('source_install.run') as run:
            self.assertEqual(check_source_host(), 'pending-image')
            run.assert_not_called()
            probe.assert_not_called()
            self.assertEqual(check_source_host(allow_pull=True), 'nvidia-device-requests')
            run.assert_called_once_with(['docker','pull','--platform=linux/arm64',UBUNTU],timeout=900)
            probe.assert_called_once_with(image)

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

    def test_registry_namespace_preserves_locked_digests(self):
        sha='a'*64
        ref='docker.io/library/node@sha256:'+sha
        self.assertEqual(rewrite(ref,'https://public.ecr.aws/docker'),
                         'public.ecr.aws/docker/library/node@sha256:'+sha)
        self.assertEqual(rewrite('docker.io/valkey/valkey@sha256:'+sha,'https://public.ecr.aws/docker'),
                         'public.ecr.aws/valkey/valkey@sha256:'+sha)
        for value in ('https://mirror.example/a/../b','https://mirror.example/%2e',
                      'https://user@mirror.example/cache','https://mirror.example/cache?token=sample'):
            with self.subTest(value=value), self.assertRaises(InstallError):
                rewrite(ref,value)

    def test_desktop_relay_is_loopback_scoped_and_preserves_the_pin(self):
        pin='@sha256:'+'a'*64
        relay='127.0.0.1:47183'
        mirror='https://public.ecr.aws/docker'
        for repo in ('guacamole/guacamole', 'guacamole/guacd'):
            ref='docker.io/'+repo+pin
            self.assertEqual(rewrite(ref,mirror,relay),relay+'/'+repo+pin)
            self.assertEqual(rewrite(ref,desktop_relay=relay),relay+'/'+repo+pin)
        self.assertEqual(rewrite('docker.io/library/node'+pin,mirror,relay),
                         'public.ecr.aws/docker/library/node'+pin)
        self.assertEqual(rewrite('docker.io/guacamole/guacd:latest',mirror,relay),
                         'docker.io/guacamole/guacd:latest')
        for value in ('127.0.0.1:65536','192.0.2.1:47183','127.0.0.1:1/path','http://127.0.0.1:1'):
            with self.subTest(value=value), self.assertRaises(InstallError):
                rewrite(ref,mirror,value)

    def test_docker_build_rewrites_explicit_file_options(self):
        from source_network import main
        import sys
        sha='a'*64
        with tempfile.TemporaryDirectory() as tmp:
            dockerfile=Path(tmp)/'candidate.Dockerfile'
            dockerfile.write_text('FROM docker.io/library/node@sha256:'+sha+'\n')
            def check(args):
                token=next(a for a in args if 'Dockerfile-' in a)
                content=Path(token.split('=',1)[-1]).read_text()
                self.assertIn('public.ecr.aws/docker/library/node@sha256:'+sha,content)
                return 0
            for flags in (['-f',str(dockerfile)],['--file',str(dockerfile)],['--file='+str(dockerfile)]):
                with self.subTest(flags=flags), patch.dict(os.environ,{
                    'TEAMAIBOX_REAL_DOCKER':'docker','TEAMAIBOX_REGISTRY_MIRROR':'https://public.ecr.aws/docker',
                    'TEAMAIBOX_NETWORK_WORK':tmp}), patch.object(sys,'argv',['docker','build',*flags,tmp]), \
                    patch('source_network.subprocess.call',side_effect=check):
                    self.assertEqual(main(),0)

    def test_penpot_emsdk_context_checks_hash_before_reuse(self):
        from source_network import emsdk_context
        content=b'verified-compiler'
        inputs=(('compiler.tar.xz','official/compiler.tar.xz',len(content),hashlib.sha256(content).hexdigest()),)
        with tempfile.TemporaryDirectory() as tmp, patch('source_network._EMSDK_INPUTS',inputs), \
             patch('fetch_public_models.range_download',side_effect=lambda _url,_row,_cache,out,**_kw:out.write(content)) as download:
            path=emsdk_context(tmp)/'compiler.tar.xz'
            self.assertEqual(path.read_bytes(),content)
            self.assertEqual(emsdk_context(tmp),path.parent)
            self.assertEqual(download.call_count,1)
            path.write_bytes(b'X'*len(content))
            with self.assertRaisesRegex(InstallError,'cache SHA-256 mismatch'):
                emsdk_context(tmp)

    def test_penpot_emsdk_wrapper_scopes_prefetch_to_frontend(self):
        import sys
        from source_network import main
        dockerfile=Path(__file__).resolve().parent/'images/penpot-editor-source.Dockerfile'
        with tempfile.TemporaryDirectory() as tmp:
            def check(args):
                raw=Path(args[args.index('--file')+1]).read_text()
                front='frontend-runtime' in args
                self.assertEqual('EMSDK_KEEP_DOWNLOADS=1 ./emsdk install 4.0.6' in raw,front)
                self.assertEqual('--build-context' in args,front)
                return 0
            with patch.dict(os.environ,{'TEAMAIBOX_REAL_DOCKER':'docker','TEAMAIBOX_NETWORK_WORK':tmp}), \
                 patch('source_network.emsdk_context',return_value=Path(tmp)) as prepare, \
                 patch('source_network.subprocess.call',side_effect=check):
                for target in ('backend-runtime','frontend-runtime'):
                    with patch.object(sys,'argv',['docker','build','--target',target,'--file',str(dockerfile),tmp]):
                        self.assertEqual(main(),0)
                self.assertEqual(prepare.call_count,1)

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
            self.assertEqual(metadata(repo,revision,'https://huggingface.co',cache,cached_only=True),result)
            self.assertIsNone(metadata(repo,'0'*40,'https://huggingface.co',cache,cached_only=True))
            self.assertIsNone(metadata('example/missing',revision,'https://huggingface.co',cache,cached_only=True))

    def test_casting_cache_requires_all_locked_revisions_before_using_local_git(self):
        from source_network import CASTING_GIT, casting_git_context
        from source_install import ROOT
        recipe=(ROOT/'deploy/casting/Public.Dockerfile').read_text()
        with tempfile.TemporaryDirectory() as tmp:
            cache=Path(tmp).resolve()
            for name in CASTING_GIT:
                (cache/(name+'.git')).mkdir()
            def git(args, **kwargs):
                return CASTING_GIT[Path(args[args.index('--git-dir')+1]).stem][1]
            with patch('source_network.subprocess.check_output',side_effect=git), \
                 patch('source_network.subprocess.run') as fsck:
                rendered=casting_git_context(recipe,cache)
                self.assertIn('RUN --mount=from=taib-casting-git',rendered)
                self.assertIn('fetch --update-shallow',rendered)
                self.assertIn('cargo build --release --locked',rendered)
                self.assertEqual(fsck.call_count,len(CASTING_GIT))
            with patch('source_network.subprocess.check_output',return_value='0'*40):
                with self.assertRaisesRegex(InstallError,'revision differs'):
                    casting_git_context(recipe,cache)

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
