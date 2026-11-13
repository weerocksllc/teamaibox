"""Scope checks for the source Design deployment; no host or Docker writes."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from factory_applications import statements
from offline_common import InstallError, digest, write_json
import source_design as design
from source_design_lifecycle import activation_allowed, agent_idle, check_agent_layout, quiesce_agents, safe_snapshot


class SourceDesignTests(unittest.TestCase):
    def setUp(self):
        self.root = Path('/var/tmp/example-design-instance')
        self.state = dict(installationId='6944a615-a036-4b45-9429-1a9d599a4277', sourceIdentity='a'*64,
                          project='teamaibox-design-6944a615a0364b4594291a9d599a4277', port=None)
        self.images = {role: 'sha256:' + f'{i:064x}' for i, role in enumerate(sorted(design.IMAGE_ROLES), 1)}

    def render(self):
        return design.render(design.ROOT, self.root, self.state, self.images)

    def test_internal_stack_uses_real_migrations_and_only_instance_owned_paths(self):
        _, files, directories, secrets = self.render()
        compose = files['compose.json']
        self.assertEqual(set(compose['services']), design.SERVICES)
        self.assertTrue(all(v['internal'] and 'external' not in v and 'name' not in v for v in compose['networks'].values()))
        self.assertTrue(all('ports' not in row for row in compose['services'].values()))
        self.assertTrue(all(v['pull_policy'] == 'never' for v in compose['services'].values()))
        self.assertEqual(compose['services']['database-migrate']['entrypoint'], ['/usr/local/bin/teamaibox-apply-migrations'])
        self.assertEqual(compose['services']['platform-api']['entrypoint'][-1], '/opt/teamaibox/apps/platform-api/server/main.mjs')
        self.assertEqual(compose['services']['object-service']['image'], self.images['platform-api'])
        self.assertEqual(compose['services']['object-service']['user'], '1000:1000')
        self.assertEqual(compose['services']['penpot-backend']['tmpfs'], ['/tmp:rw,exec,nosuid,nodev,size=256m'])
        raw = json.dumps(compose)
        for forbidden in ('docker.sock', '/dev/kvm', '/etc/teamaibox', 'ca.key', 'PLATFORM_PENPOT_MCP_KEY_FILE', 'PLATFORM_API_BOOTSTRAP_FILE'):
            self.assertNotIn(forbidden, raw)
        self.assertEqual({v['driver_opts']['device'] for v in compose['volumes'].values()},
                         {str(self.root / 'data' / d['path']) for d in directories})
        self.assertEqual({v['file'] for v in compose['secrets'].values()}, {str(self.root / s['path']) for s in secrets})
        self.assertTrue(all(v['mode'] in ('0400', '0440', '0600') for v in secrets))

    def test_loopback_mode_exposes_only_web_on_selected_port(self):
        self.state['port'] = 18443
        origin, files, _, _ = self.render()
        compose = files['compose.json']
        self.assertEqual(origin, 'https://localhost:18443')
        self.assertEqual([r for r, s in compose['services'].items() if 'ports' in s], ['web'])
        self.assertEqual(compose['services']['web']['ports'], [dict(target=8443, published='18443', host_ip='127.0.0.1', protocol='tcp')])
        self.assertEqual([r for r, s in compose['services'].items() if 'access' in s['networks']], ['web'])

    def test_generation_switch_keeps_logical_id_and_separates_persistent_volume_bindings(self):
        baseline = self.render()[1]['compose.json']
        root = self.root.with_name('example-design-candidate')
        slot = 'f06bc281-e778-46c7-8fa7-07f677424001'
        candidate = {**self.state, 'slotId':slot, 'project':'teamaibox-design-'+slot.replace('-', '')}
        new = design.render(design.ROOT, root, candidate, self.images)[1]['compose.json']
        self.assertEqual(set(baseline['volumes']),set(new['volumes']))
        for key, spec in new['volumes'].items():
            self.assertEqual(spec['labels'], baseline['volumes'][key]['labels'])
            self.assertTrue(Path(spec['driver_opts']['device']).is_relative_to(root / 'data'))
            old_name = baseline['volumes'][key].get('name',self.state['project']+'_'+key)
            self.assertNotEqual(old_name,spec.get('name',candidate['project']+'_'+key))

    def test_generation_journal_fences_inactive_slot(self):
        with tempfile.TemporaryDirectory() as tmp, patch('source_design_lifecycle.private_root'):
            baseline = Path(tmp).resolve() / 'old'
            baseline.mkdir()
            candidate = baseline.with_name('new')
            slot = 'f06bc281-e778-46c7-8fa7-07f677424001'
            old = {**self.state,'schemaVersion':1,'root':str(baseline),'engineId':'test-engine','composeSha256':'a'*64}
            new = {**old,'root':str(candidate),'baselineRoot':str(baseline),'slotId':slot}
            row = dict(schemaVersion=1, baseline=str(baseline), candidate=str(candidate), slotId=slot,
                       installationId=old['installationId'], engineId=old['engineId'], baselineComposeSha256=old['composeSha256'])
            write_json(baseline/'design-state.json', old)
            for phase in ('preparing','upgraded','rolling-back','rolled-back'):
                write_json(baseline/'generation-switch.json',{**row,'phase':phase})
                for path, state, active in ((baseline,old,phase=='rolled-back'),(candidate,new,phase=='upgraded')):
                    if active:
                        activation_allowed(path,state)
                    else:
                        with self.assertRaisesRegex(InstallError,'inactive'):
                            activation_allowed(path,state)

    def test_design_profile_does_not_weaken_appliance_catalog_contract(self):
        catalog = self.render()[1]['config/application-catalog.json']
        arguments = self.state['installationId'], catalog['applications'], False, catalog['requiredApplications']
        with self.assertRaisesRegex(InstallError, 'omit shipped applications'):
            statements(*arguments)
        sql = statements(*arguments, profile='design')
        self.assertIn('official.penpot', sql)
        self.assertNotIn('official.assistant', sql)
        with self.assertRaises(InstallError):
            statements(self.state['installationId'], [], False, [], profile='design')

    def test_reuse_requires_exact_manifest_and_arm64_image_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'image-map.json'
            path.write_text(json.dumps({'schemaVersion': 1, 'images': self.images}))
            with patch.object(design, 'run') as docker:
                with self.assertRaisesRegex(InstallError, 'SHA-256 mismatch'):
                    design.reused_images(path, '0'*64)
                docker.assert_not_called()
                docker.side_effect = lambda args: json.dumps([dict(Id=args[-1], Os='linux', Architecture='arm64')])
                self.assertEqual(design.reused_images(path, digest(path)), self.images)
                docker.side_effect = lambda args: json.dumps([dict(Id=args[-1], Os='linux', Architecture='amd64')])
                with self.assertRaisesRegex(InstallError, 'wrong local image identity'):
                    design.reused_images(path, digest(path))

    def test_existing_foreign_container_blocks_lifecycle_action(self):
        compose = self.render()[1]['compose.json']
        row = {'Id': 'a'*64, 'Image': self.images['web'], 'Config': {'Labels': {'com.docker.compose.service': 'web'}}}
        with patch.object(design, 'run', side_effect=[row['Id'], json.dumps([row])]) as docker:
            with self.assertRaisesRegex(InstallError, 'foreign or changed'):
                design.owned_resources(compose, self.state)
        self.assertEqual(docker.call_count, 2)

    def test_ai_uses_factory_controller_and_only_the_dedicated_socket(self):
        socket = '/var/tmp/example-design-engine/docker.sock'
        model = self.root / 'assets/assistant-model'
        self.state.update(ai=True, engineSocket=socket)
        images = {role: 'sha256:' + f'{i:064x}' for i, role in enumerate(sorted(design.IMAGE_ROLES | design.AI_IMAGES), 1)}
        _, files, _, _ = design.render(design.ROOT, self.root, self.state, images, model)
        compose = files['compose.json']
        cfg = files['config/agent-controller.json']
        self.assertEqual(cfg['image'], images['agent-sandbox'])
        self.assertEqual(cfg['penpot']['mcpOrigin'], 'http://penpot-mcp:4401')
        self.assertTrue(all(network['internal'] for network in compose['networks'].values()))
        self.assertEqual({k for k,v in compose['services'].items() if 'design-model' in v['networks']},
                         {'compute-gateway','assistant-worker'})
        socket_mounts = [(role, v['source']) for role, svc in compose['services'].items()
                         for v in svc.get('volumes', []) if isinstance(v, dict) and v['target'] == '/var/run/docker.sock']
        self.assertEqual(socket_mounts, [('agent-bridge', socket)])
        self.assertTrue(compose['services']['assistant-worker']['volumes'][0]['read_only'])
        with self.assertRaisesRegex(InstallError, 'dedicated engine'):
            design.render(design.ROOT, self.root, {**self.state, 'engineSocket':None}, images, model)

    def test_ai_candidate_uses_its_own_workspace_volume_and_named_networks(self):
        image_map = {**self.images, **{role:'sha256:' + 'e'*64 for role in design.AI_IMAGES}}
        old = {**self.state,'ai':True,'engineSocket':'/var/tmp/engine/docker.sock'}
        target = self.root.with_name('candidate')
        new = {**old,'slotId':'f06bc281-e778-46c7-8fa7-07f677424001'}
        baseline = design.render(design.ROOT,self.root,old,image_map,self.root/'assets/assistant-model')[1]
        candidate = design.render(design.ROOT,target,new,image_map,target/'assets/assistant-model')[1]
        a, b = (x['config/agent-controller.json'] for x in (baseline,candidate))
        self.assertNotEqual(a['volume'],b['volume'])
        self.assertTrue(set(a['networks']).isdisjoint(b['networks']))
        compose = candidate['compose.json']
        self.assertEqual(b['volume'],compose['volumes']['factory_agent_state']['name'])
        self.assertEqual(b['networks'],[compose['networks'][x]['name'] for x in ('agent-control','agent-egress-proxy')])
        self.assertEqual(compose['volumes']['factory_agent_state']['driver_opts']['device'],str(target/'data/agent/dynamic'))
        self.assertEqual(a['penpot'],b['penpot'])

    def test_busy_agent_preflight_never_stops_a_container(self):
        io = Mock()
        with patch('source_design_lifecycle.dynamic_resources',return_value=[{'Id':'agent','State':{'Running':True}}]):
            io.run.side_effect = ['f','busy']
            with self.assertRaisesRegex(InstallError,'active or unverified'):
                agent_idle(io,self.root,{}, {'postgres':'pg'},require_db=True)
        self.assertEqual([call.args[0][:2] for call in io.run.call_args_list],[['docker','exec']]*2)

    def test_agent_image_must_keep_the_original_native_data_and_configuration_paths(self):
        io = Mock()
        def config(*items):
            return {'Config':{'Env':list(items)}}
        old = config('XDG_DATA_HOME=/workspace/data','OPENCODE_DISABLE_CHANNEL_DB=1','TERM=dumb')
        io.inspect_image.side_effect = [old,config('XDG_DATA_HOME=/workspace/data','OPENCODE_DISABLE_CHANNEL_DB=1','TERM=xterm')]
        check_agent_layout(io,'old','new')
        io.inspect_image.side_effect = [old,config('XDG_DATA_HOME=/workspace/other','OPENCODE_DISABLE_CHANNEL_DB=1')]
        with self.assertRaisesRegex(InstallError,'state paths'):
            check_agent_layout(io,'old','new')

    def test_agent_that_became_busy_at_ingress_fence_is_not_stopped(self):
        io = Mock()
        rows = [{'Id':role,'Config':{'Labels':{'com.docker.compose.service':role}},'State':{'Running':True}}
                for role in ('postgres','web','platform-api','agent-bridge')]
        with patch('source_design_lifecycle.agent_idle',side_effect=[None,InstallError('busy')]):
            with self.assertRaisesRegex(InstallError,'busy'):
                quiesce_agents(io,self.root,{},rows)
        self.assertEqual([call.args[0][-1] for call in io.run.call_args_list],['web','platform-api','agent-bridge'])

    def test_ai_snapshot_preserves_user_symlinks_without_accepting_managed_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path,'read_text',return_value='1 2 0:1 / / rw - ext4 dev rw\n'):
            root = Path(tmp).resolve()
            user = root/'data'/'agent'/'dynamic'/('a'*32)
            for path in (root/'secrets',root/'https',user/'workspace',user/'runtime'):
                path.mkdir(parents=True)
            (user/'workspace'/'link').symlink_to('/must-not-be-followed')
            safe_snapshot(root,ai=True)
            with self.assertRaisesRegex(InstallError,'unsupported Design snapshot entry'):
                safe_snapshot(root)
            (user/'runtime'/'link').symlink_to('/must-not-be-followed')
            with self.assertRaisesRegex(InstallError,'unsupported Design snapshot entry'):
                safe_snapshot(root,ai=True)


if __name__ == '__main__':
    unittest.main()
