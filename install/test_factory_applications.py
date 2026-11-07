import json
from pathlib import Path
import re
import unittest
import uuid
import copy
import tempfile
from unittest.mock import patch

from factory_applications import statements, apply, check_design_gateway
from factory_application_contract import BASE_APPLICATIONS
from factory_bootstrap import expand
from factory_recipe import assemble
from offline_common import InstallError


class ApplicationsTests(unittest.TestCase):
    def setUp(self):
        recipe = assemble(Path(__file__).resolve().parents[1])
        self.compose = next(r['value'] for r in recipe['templates'] if r['output'] == 'config/core.json')
        value = next(r['value'] for r in recipe['templates'] if r['output'] == 'config/application-catalog.json')
        self.rows = expand(value, {k: 'sha256:' + 'a'*64 for k in re.findall(r'@@([^@]+)@@', json.dumps(value))})['applications']

    def test_all_shipped_apps_have_resolved_unsigned_package_manifests(self):
        self.assertEqual(len(self.rows), 9)
        for row in self.rows:
            self.assertEqual(row['manifest']['id'], 'official.' + row['role'].removesuffix('-plugin'))
            self.assertNotIn('signature', row['manifest'])
        self.assertNotIn('__RELEASE_PIPELINE', json.dumps(self.rows))

    def test_catalog_registration_is_insert_only_with_conflict_assertions(self):
        identity = str(uuid.uuid4())
        sql = statements(identity, self.rows)
        self.assertEqual(sql, statements(identity, self.rows))
        self.assertNotEqual(sql, statements(str(uuid.uuid4()), self.rows))
        self.assertNotIn('DO UPDATE', sql)
        self.assertNotIn('DELETE', sql)
        self.assertIn("AND lifecycle_state='discovered' AND current_version_id IS NULL", sql)
        self.assertNotIn('INSERT', statements(identity, self.rows, True))
        with self.assertRaises(InstallError):
            statements(identity, self.rows[:-1])

    def test_core_observations_have_explicit_keys_without_developer_project(self):
        agent = self.compose['services']['node-agent']
        self.assertEqual(agent['environment']['TEAMAIBOX_NODE_METRICS_ENABLED'], 'true')
        self.assertEqual(agent['devices'], ['/dev/kvm:/dev/kvm:rw'])
        self.assertIn('@@KVM_GID@@', agent['group_add'])
        self.assertEqual(agent['environment']['TEAMAIBOX_HOST_STORAGE_ANCHOR'], '@@DATA@@')
        self.assertTrue(any(m.get('source') == '/sys' and m.get('target') == '/host/sys'
            and m.get('read_only') for m in agent['volumes'] if isinstance(m, dict)))
        for name, service in self.compose['services'].items():
            if name in ('platform-api', 'scheduler', 'object-service', 'messaging', 'event-bus'):
                self.assertEqual(service['labels']['com.teamaibox.core-service-key'], name)
                self.assertEqual(service['labels']['com.teamaibox.managed'], 'true')

    def test_native_dependency_failure_prevents_catalog_registration(self):
        rows=copy.deepcopy(self.rows)
        native=copy.deepcopy(rows[0]['manifest']);native['id']='official.penpot';native['images']=[]
        services=[]
        for index, role in enumerate(['penpot-frontend','penpot-backend','penpot-exporter','penpot-mcp']):
            native['images'].append(dict(name=role,variants=[dict(architecture='linux/arm64/v8',digest='sha256:'+str(index+1)*64)]))
            services.append(dict(role=role,imageName=role,readiness='container-health'))
        rows.append(dict(role='penpot-frontend',manifest=native,services=services))
        required=sorted(BASE_APPLICATIONS|{'official.penpot'})
        installation=str(uuid.uuid4())
        by_role={service['role']:(row,service) for row in rows for service in row['services']}
        mismatch=[False]
        def command(args):
            if args[:3]==['docker','ps','-q']:
                return args[-1].rsplit('=',1)[1]
            if args[:2]==['docker','inspect']:
                role=args[2];row,service=by_role[role]
                image=next(i for i in row['manifest']['images'] if i['name']==service['imageName'])['variants'][0]['digest']
                if mismatch[0] and role=='penpot-backend':image='sha256:'+'0'*64
                return json.dumps([dict(Id=role,Image=image,Config=dict(Labels={
                    'com.teamaibox.installation-id':installation,'com.teamaibox.service-role':role}),
                    State=dict(Running=True,Health=dict(Status='healthy')))])
            if args[:2]==['docker','exec']:
                row,service=by_role[args[2]]
                self.assertEqual(service['readiness'],'plugin-http','native service must not run a Node UI probe')
                return json.dumps(dict(status='ready',pluginId=row['manifest']['id'],version=row['manifest']['version']))
            self.fail('unexpected command')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'config').mkdir()
            (root/'config/application-catalog.json').write_text(json.dumps(dict(applications=rows,requiredApplications=required)))
            with patch('appliance_installation.load',return_value={'installationId':installation}), patch('factory_applications.run',side_effect=command), patch('factory_database.query') as query, patch('factory_applications.check_design_gateway') as gateway:
                self.assertEqual(apply(root)['applications'],10);query.assert_called_once()
                gateway.assert_called_once_with({'installationId':installation})
                query.reset_mock();gateway.side_effect=InstallError('protected Design editor route is not active')
                with self.assertRaisesRegex(InstallError,'editor route'):
                    apply(root)
                query.assert_not_called()
                gateway.reset_mock();gateway.side_effect=None
                query.reset_mock();mismatch[0]=True
                with self.assertRaisesRegex(InstallError,'image differs'):
                    apply(root)
                query.assert_not_called()
                gateway.assert_not_called()

    def test_factory_requires_a_mounted_editor_route_that_denies_anonymous_access(self):
        api = {'Id':'product-api','Config':{'Labels':{'com.teamaibox.installation-id':'owned',
              'com.teamaibox.service-role':'platform-api'}}}
        with patch('appliance_installation.resolve',return_value=api), patch('factory_applications.run') as cmd:
            expected={'editor':{'status':401,'code':'invalid_session'},'mcp':{'status':403,'code':'penpot_call_denied'}}
            cmd.return_value=json.dumps(expected)
            check_design_gateway({'installationId':'owned'})
            self.assertIn('/api/v1/design/editor/',cmd.call_args.args[0][-1])
            self.assertIn('/internal/v1/design/call-authority',cmd.call_args.args[0][-1])
            for status, code in ((404,'not_found'),(200,None),(426,'https_required')):
                cmd.return_value=json.dumps({**expected,'editor':{'status':status,'code':code}})
                with self.subTest(status=status), self.assertRaisesRegex(InstallError,'editor route'):
                    check_design_gateway({'installationId':'owned'})
            cmd.return_value=json.dumps({**expected,'mcp':{'status':404,'code':'not_found'}})
            with self.assertRaisesRegex(InstallError,'MCP route'):
                check_design_gateway({'installationId':'owned'})
            cmd.reset_mock()
            with self.assertRaisesRegex(InstallError,'does not belong'):
                check_design_gateway({'installationId':'foreign'})
            cmd.assert_not_called()


if __name__ == '__main__':
    unittest.main()
