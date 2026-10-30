import json
from pathlib import Path
import tempfile
import unittest

from artifact_validation import validate_asset, validate_android_bindings
from offline_common import InstallError
from package import inventory_asset


def asset_fixture(directory, role):
    """Small structural fixtures; not runnable models or release artifacts."""
    files = {'asset': b'data'}
    if role.endswith('-model'):
        files['LICENSE'] = b'Synthetic test license, not a release artifact'
    if role in ('assistant-model', 'translation-model', 'embedding-model'):
        files.update({'config.json': b'{}', 'tokenizer_config.json': b'{}',
                      'tokenizer.json': b'{}', 'model.safetensors': b'fixture'})
    if role == 'asr-model':
        files.update({'config.json': b'{}', 'model.bin': b'fixture', 'tokenizer.json': b'{}'})
    if role == 'ocr-model':
        files.update({'huggingface/hub/models--fixture/snapshots/revision/config.json': b'{}', 'hunyuanocr-dflash/config.json': b'{}',
                      'hunyuanocr-dflash/model.safetensors': b'fixture',
                      'huggingface/hub/models--fixture/snapshots/revision/model.safetensors': b'fixture'})
    if role == 'drawing-model':
        files.update({'model_index.json': b'{"transformer":["diffusers","Fixture"]}',
                      'transformer/model.safetensors': b'fixture'})
    files.update({n: b'fixture' for n in {
        'computer-firmware': ['CODE.fd', 'VARS.fd'], 'computer-drivers': ['virtio.iso'],
        'drawing-runtime': ['flux2_bf16_protected_server.py'],
    }.get(role, [])})
    if role == 'guest-host-tools':
        files.update({n: b'\x7fELF\x02\x01' + b'\0' * 12 + b'\xb7\x00'
                      for n in ('phone-storage-helper', 'factory-worker-spec')})
    if role in ('android-standard', 'android-google'):
        files = {'manifest.json': json.dumps(dict(schemaVersion=1, androidVersion='17', baseBuildId='16102939',
            systemFamily='google-play' if role == 'android-google' else 'standard',
            runtimeImageId='sha256:' + 'a' * 64)).encode(), 'NOTICE.txt': b'Fixture, not a ROM'}
    for name, raw in files.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)


class ArtifactTests(unittest.TestCase):
    def test_cached_factory_asset_cannot_omit_drawing_ui_routes(self):
        from factory_recipe import emit
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'factory'
            recipe, _ = emit(Path(__file__).resolve().parents[1], root)
            validate_asset(inventory_asset(root, 'assets/factory', 'factory-configuration'), root)
            template = next(t for t in recipe['templates'] if t['output'] == recipe['composeFile'])
            path = root / template['input']
            compose = json.loads(path.read_text())
            for aliases in (None, 'local/drawing-default,drawing.automatic'):
                with self.subTest(aliases=aliases):
                    env = compose['services']['platform-api']['environment']
                    if aliases is None:
                        env.pop('DRAWING_MODEL_ALIASES', None)
                    else:
                        env['DRAWING_MODEL_ALIASES'] = aliases
                    path.write_text(json.dumps(compose))
                    with self.assertRaisesRegex(InstallError, 'drawing UI routes are incomplete'):
                        validate_asset(inventory_asset(root, 'assets/factory', 'factory-configuration'), root)

    def test_every_model_requires_license_before_packaging(self):
        for role in ('assistant', 'translation', 'embedding', 'asr', 'ocr', 'drawing'):
            with self.subTest(role=role), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                asset_fixture(root, role + '-model')
                (root / 'LICENSE').unlink()
                with self.assertRaisesRegex(InstallError, 'license text before packaging'):
                    validate_asset(inventory_asset(root, 'assets/model', role + '-model'), root)

    def test_android_metadata_binds_to_the_exported_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            asset_fixture(root, 'android-google')
            row = validate_asset(inventory_asset(root, 'assets/google', 'android-google'), root)
            validate_android_bindings([row], [dict(role='phone-google-runtime', imageId='sha256:' + 'a' * 64)])
            with self.assertRaisesRegex(InstallError, 'does not match'):
                validate_android_bindings([row], [dict(role='phone-google-runtime', imageId='sha256:' + 'b' * 64)])

    def test_driver_directory_cannot_smuggle_an_os_iso(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            asset_fixture(root, 'computer-drivers')
            (root / 'windows.iso').write_bytes(b'not a driver')
            with self.assertRaisesRegex(InstallError, 'installation ISOs'):
                validate_asset(inventory_asset(root, 'assets/drivers', 'computer-drivers'), root)

    def test_missing_shard_is_rejected_even_with_matching_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            asset_fixture(root, 'assistant-model')
            (root / 'model.safetensors.index.json').write_text(json.dumps({'weight_map': {'tensor': 'omitted.safetensors'}}))
            with self.assertRaisesRegex(InstallError, 'shard omitted'):
                validate_asset(inventory_asset(root, 'assets/model', 'assistant-model'), root)

    def test_missing_firmware_and_wrong_architecture_are_rejected(self):
        for role, name, data in [('computer-firmware', 'VARS.fd', None),
                                 ('guest-host-tools', 'factory-worker-spec', b'not ARM64')]:
            with self.subTest(role=role), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                asset_fixture(root, role)
                if data is None:
                    (root / name).unlink()
                else:
                    (root / name).write_bytes(data)
                with self.assertRaises(InstallError):
                    validate_asset(inventory_asset(root, 'assets/runtime', role), root)

    def test_guest_state_is_not_a_release_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'accounts.db').write_bytes(b'user data')
            with self.assertRaisesRegex(InstallError, 'mutable/user'):
                validate_asset(inventory_asset(root, 'assets/android', 'android-standard'), root)


if __name__ == '__main__':
    unittest.main()
