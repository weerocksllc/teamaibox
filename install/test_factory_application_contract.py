import unittest
from factory_application_contract import BASE_APPLICATIONS, bind_application_images, validate_application_set, application_services
from offline_common import InstallError


class ApplicationContractTests(unittest.TestCase):
    def rows(self, keys):
        return [dict(manifest=dict(id=key)) for key in keys]

    def test_required_identities_not_a_magic_count(self):
        required = sorted(BASE_APPLICATIONS | {'official.penpot'})
        validate_application_set(self.rows(required), required)
        for keys in [required[:-1], required + [required[0]], [*required[:-1], 'official.unexpected']]:
            with self.assertRaises(InstallError):
                validate_application_set(self.rows(keys), required)
        with self.assertRaises(InstallError):
            validate_application_set(self.rows(['official.penpot']), ['official.penpot'])

    def manifest(self):
        return dict(images=[dict(name=name, variants=[dict(architecture='linux/arm64/v8')])
                            for name in ['editor', 'backend', 'exporter', 'mcp']])

    def test_each_native_service_keeps_its_image(self):
        manifest = self.manifest()
        mapping = {name:'penpot-' + name for name in ['editor', 'backend', 'exporter', 'mcp']}
        services = bind_application_images(manifest, mapping)
        self.assertEqual(len(services), 4)
        for image in manifest['images']:
            self.assertEqual(image['variants'][0]['digest'], '@@IMAGE.' + mapping[image['name']] + '@@')
        self.assertEqual(len({image['variants'][0]['digest'] for image in manifest['images']}), 4)
        bound=application_services(dict(manifest=manifest, services=services))
        self.assertTrue(all(service['readiness']=='container-health' for service in bound))
        self.assertEqual(len({service['digest'] for service in bound}),4)
        with self.assertRaises(InstallError):
            application_services(dict(manifest=manifest, services=services[:-1]))
        with self.assertRaises(InstallError):
            application_services(dict(manifest=manifest, role='penpot-editor'))

    def test_missing_duplicate_role_and_wrong_architecture_rejected(self):
        mapping = {name:'penpot-' + name for name in ['editor', 'backend', 'exporter', 'mcp']}
        for broken in [{k:v for k,v in mapping.items() if k!='mcp'}, {**mapping, 'mcp':'penpot-editor'}]:
            with self.assertRaises(InstallError):
                bind_application_images(self.manifest(), broken)
        manifest=self.manifest();manifest['images'][0]['variants'][0]['architecture']='linux/amd64'
        with self.assertRaises(InstallError):
            bind_application_images(manifest, mapping)


if __name__ == '__main__':
    unittest.main()
