import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from ai_compilation_cache import cache_plan, cached_payload, verify_preserved, LABEL
import ai_cache_checkpoint as checkpoint


def fixture():
    return dict(Image='sha256:engine', Config=dict(User='65532:65532', Env=['HOME=/tmp', 'TORCHINDUCTOR_CACHE_DIR=/tmp/torchinductor'],
        Labels={'com.teamaibox.worker-id': 'worker', 'com.teamaibox.config-digest': 'config', 'com.teamaibox.start-spec-digest': 'spec'}),
        HostConfig=dict(Memory=4096, Tmpfs={'/tmp': 'rw,size=8g'}, Mounts=[dict(Type='volume', Source='weights', Target='/model', ReadOnly=True)]),
        Mounts=[dict(Type='volume', Name='weights', Destination='/model', RW=False)], NetworkSettings={'Networks': {}})


class CacheTests(unittest.TestCase):
    def test_scoped_paths_stable_across_restart_but_isolated_across_image_and_model(self):
        old = fixture(); plan = cache_plan(old)
        self.assertEqual({p['Target'] for p in plan}, {'/tmp/torchinductor','/tmp/.cache','/tmp/.triton/cache','/tmp/.nv/ComputeCache'})
        old['Id'] = 'replacement-container'
        self.assertEqual(cache_plan(old), plan)
        old['Image'] = 'sha256:new-engine'
        self.assertFalse({p['Source'] for p in plan} & {p['Source'] for p in cache_plan(old)})
        old['Image'] = 'sha256:engine'; old['Config']['Labels']['com.teamaibox.worker-id'] = 'other'
        self.assertNotEqual(cache_plan(old), plan)

    def test_explicit_vllm_path_and_existing_persistent_flux_are_respected(self):
        old = fixture(); old['Config']['Env'].append('VLLM_CACHE_ROOT=/tmp/vllm')
        self.assertIn('/tmp/vllm', [p['Target'] for p in cache_plan(old)])
        self.assertIn('/tmp/.cache', [p['Target'] for p in cache_plan(old)])
        self.assertNotIn('/tmp/.cache/vllm', [p['Target'] for p in cache_plan(old)])
        old['Config']['Env'] = ['HOME=/tmp', 'TORCHINDUCTOR_CACHE_DIR=/offload/torchinductor']
        self.assertEqual(cache_plan(old), [])
        old['Config']['Env'] = []
        self.assertEqual(cache_plan(old), [])

    def test_only_cache_mounts_and_marker_change_not_models_limits_or_temporary_storage(self):
        old = fixture(); plan = cache_plan(old); payload = cached_payload(old, plan)
        current = copy.deepcopy(old)
        current['Config'] = {k:v for k,v in payload.items() if k not in ('HostConfig','NetworkingConfig')}
        current['HostConfig'] = payload['HostConfig']
        current['Mounts'] += [dict(Type='volume', Destination=p['Target'], Name=p['Source'], RW=True) for p in plan]
        for mount in current['HostConfig']['Mounts']:
            if mount.get('ReadOnly') is False: mount.pop('ReadOnly')
        before = copy.deepcopy(current)
        verify_preserved(old, current, plan)
        self.assertEqual(current, before)
        current['Mounts'][0]['RW'] = True
        with self.assertRaisesRegex(RuntimeError, 'model_data_mount_changed'): verify_preserved(old, current, plan)

    def test_interrupted_manifest_pair_is_completed_before_boot(self):
        with tempfile.TemporaryDirectory() as directory:
            config, manifest = Path(directory)/'config.json', Path(directory)/'manifest.json'
            actual = checkpoint.atomic_json
            def power_loss(path, value):
                if path == config: raise OSError('simulated power loss')
                actual(path, value)
            with patch.object(checkpoint, 'atomic_json', power_loss):
                with self.assertRaises(OSError): checkpoint.commit(config, manifest, {'new':True}, {'containers':['new']})
            checkpoint.finish(config, manifest)
            self.assertEqual(json.loads(config.read_text()), {'new':True})
            self.assertEqual(json.loads(manifest.read_text()), {'containers':['new']})
            self.assertFalse(config.with_suffix('.cache-checkpoint.json').exists())


if __name__ == '__main__': unittest.main()
