import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build_penpot_native as native
import source_penpot as design
from apply_opencode_transport_patch import source_tree
from offline_common import InstallError
from source_install import Pipeline


class NativePreparationTests(unittest.TestCase):
    def test_exact_source_and_links_are_checked_on_first_use_and_reuse(self):
        with tempfile.TemporaryDirectory(prefix='design-source-check-') as temporary:
            root=Path(temporary).resolve(); original=root/'input'; original.mkdir()
            (original/'file').write_text('synthetic public source')
            (original/'link').symlink_to('file')
            lock={'tree':source_tree(original).hex()}
            with patch.object(native,'read_json',return_value=lock):
                result=native.prepare_original(root/'prepared',original)
                self.assertEqual(source_tree(result).hex(),lock['tree'])
                native.prepare_original(result)
                (result/'file').write_text('changed')
                with self.assertRaisesRegex(InstallError,'cached native source changed'):
                    native.prepare_original(result)

    def test_escaping_source_link_rejected_without_touching_target(self):
        with tempfile.TemporaryDirectory(prefix='design-source-check-') as temporary:
            root=Path(temporary).resolve(); original=root/'input'; original.mkdir()
            (root/'private').write_text('synthetic private material')
            (original/'link').symlink_to('../private')
            with patch.object(native,'read_json',return_value={'tree':source_tree(original).hex()}):
                with self.assertRaisesRegex(InstallError,'escapes'):
                    native.prepare_original(root/'prepared',original)
            self.assertFalse((root/'prepared').exists())
            self.assertEqual((root/'private').read_text(),'synthetic private material')

    def test_native_key_is_bound_to_current_source_and_recipe(self):
        # A mismatched artifact is rejected before creating an Agent image.
        with tempfile.TemporaryDirectory(prefix='design-source-check-') as temporary:
            with self.assertRaisesRegex(InstallError,'unpinned'):
                design.dependency('postgres:latest')


class AssemblyTests(unittest.TestCase):
    def test_pipeline_resumes_without_rebuilding_design_or_mutating_existing_maps(self):
        with tempfile.TemporaryDirectory(prefix='design-assembly-check-') as temporary:
            root=Path(temporary).resolve()
            ids={role:'sha256:'+str(index)*64 for index,role in enumerate(design.ROLES,1)}
            base='sha256:'+'a'*64; agent='sha256:'+'b'*64
            def plugin(image,destination):
                destination.mkdir();(destination/'plugin.js').write_text('synthetic plugin')
            def sources(cache,output,original):
                output.write_text('synthetic source placeholder; not release eligible')
            def dependency(reference):
                return 'sha256:'+('c' if 'postgres@' in reference else 'd')*64
            image_info=lambda command:json.dumps([dict(Id=command[-1],Architecture='arm64')])
            with patch.object(design,'build_native',return_value=dict(artifact=str(root/'artifact'),
                    original=str(root/'original'),binarySha256='e'*64)) as build_native, \
                 patch.object(design,'build_stack',return_value=dict(images=ids)) as build_stack, \
                 patch.object(design,'build_agent',return_value=dict(imageId=agent)) as build_agent, \
                 patch.object(design,'dependency',side_effect=dependency), \
                 patch.object(design,'plugin_asset',side_effect=plugin), \
                 patch.object(design,'package_sources',side_effect=sources), \
                 patch('source_install.run',side_effect=image_info):
                pipeline=Pipeline(root/'work','synthetic-identity',root/'install')
                try:
                    images,assets=design.assemble(pipeline,root/'cache',base)
                    self.assertEqual(set(images),design.PENPOT_IMAGE_ROLES|{'agent-sandbox'})
                    self.assertEqual(images['agent-sandbox'],agent)
                    self.assertEqual(set(assets),{'penpot-plugin','penpot-corresponding-source'})
                    self.assertEqual(design.assemble(pipeline,root/'cache',base),(images,assets))
                    self.assertEqual(build_native.call_count,1)
                    self.assertEqual(build_stack.call_count,1)
                    self.assertEqual(build_agent.call_args.args[0],base)
                    self.assertEqual(set(ids),set(design.ROLES))
                    (Path(assets['penpot-plugin']['source'])/'plugin.js').write_text('tampered')
                    with self.assertRaisesRegex(InstallError,'completed output changed'):
                        design.assemble(pipeline,root/'cache',base)
                finally:
                    pipeline.lock.close()

    def test_dependency_architecture_and_digest_checked_before_admission(self):
        reference='docker.io/library/postgres@sha256:'+'a'*64
        for image in [dict(Os='linux',Architecture='amd64'),
                      dict(Os='linux',Architecture='arm64',RepoDigests=[])]:
            with self.subTest(image=image),patch.object(design,'inspect',return_value=image):
                with self.assertRaises(InstallError):
                    design.dependency(reference)


if __name__=='__main__':
    unittest.main()
