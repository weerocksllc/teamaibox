import copy
import importlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import appliance_installation as installation
import appliance_networks as networks
import appliance_phone_media as media
import appliance_compatibility as compatibility
import appliance_target as target
import appliance_https as https
import host_drift
import restore_existing_business_volumes as storage


class PortableDelivery(unittest.TestCase):
    def fixture(self, suffix):
        node='00000000-0000-4000-8000-'+str(suffix).zfill(12)
        c={'Id':str(suffix)*64,'Image':'sha256:'+str(suffix)*64,'Config':{'Env':['PLATFORM_APPLIANCE_NODE_ID='+node,'PLATFORM_APPLIANCE_ADDRESSES_FILE=/config/address.json'],
            'Labels':{'com.teamaibox.managed':'true','com.teamaibox.core-service-key':'platform-api'}},'Mounts':[{'Destination':'/config','Source':'/srv/different-'+str(suffix)}]}
        return node,c

    def test_two_independent_imports_and_idempotence(self):
        records=[]
        for suffix in (1,2):
            node,c=self.fixture(suffix);r=installation.imported(node,{'platform-api':c});records.append(r)
            self.assertEqual(installation.imported(node,{'platform-api':c},r),r)
            self.assertEqual(r['references']['publicAddresses'],f'/srv/different-{suffix}/address.json')
            with self.assertRaises(ValueError):installation.imported(node,{'platform-api':c,'web':c})
        self.assertNotEqual(records[0]['installationId'],records[1]['installationId'])
        with self.assertRaises(ValueError):installation.imported(records[0]['nodeId'],{'platform-api':self.fixture(1)[1]},records[1])

    def test_mount_resolution_production_and_imported(self):
        for target_path,host in [('/run/config/appliance','/srv/customer/config'),('/main-guest-config','/srv/existing/pool/config')]:
            c={'Mounts':[{'Destination':target_path,'Source':host}]}
            self.assertEqual(installation.host_path(c,target_path+'/phones.json'),host+'/phones.json')
        with self.assertRaises(ValueError):installation.host_path({'Mounts':[]},'/missing')

    def test_explicit_targets_no_import_connection(self):
        with patch.dict(os.environ,{},clear=True),patch('subprocess.run',side_effect=AssertionError('no connection')):
            import appliance_database
            importlib.reload(appliance_database)
            with self.assertRaises(ValueError):target.ssh_target()
            with self.assertRaises(ValueError):appliance_database.remote_psql('select 1')
            self.assertEqual(target.ssh_target('operator@10.44.2.9'),'operator@10.44.2.9')
        with patch.dict(os.environ,{'TEAMAIBOX_POSTGRES_CONTAINER':'one','TEAMAIBOX_APPLIANCE_POSTGRES_CONTAINER':'two'}):
            with self.assertRaises(ValueError):target.postgres_target()

    def test_media_rules_only_exact_ports_and_interface(self):
        nat,fwd=media.rules({'run':{'containerAddress':'172.29.3.2','firstPort':20200,'lastPort':20249}},'10.2.3.4','enp1s0')
        self.assertEqual(len(nat),2);self.assertEqual(len(fwd),4)
        self.assertTrue(all('--dport 20200:20249' in r and '-i enp1s0' in r for r in nat))
        self.assertEqual(media.rules({},None,''),([],[]))
        with self.assertRaises(ValueError):media.rules({},'127.0.0.1','eth0')

    def test_volume_identity_and_capacity(self):
        base={'version':1,'volumes':[{'source':'/srv/customer/volume.img','keyFile':'/srv/customer/key','mountPoint':'/srv/data',
            'kind':'file','mapper':'customer-data','luksUuid':'11111111-1111-4111-8111-111111111111','fsUuid':'22222222-2222-4222-8222-222222222222','minimumSize':4096,'mountOptions':'nodev,nosuid'}]}
        v=storage.validate_volumes(base)[0];storage.verify_image_size(v,8192)
        with self.assertRaises(RuntimeError):storage.verify_image_size(v,2048)
        for field,value in [('source','relative'),('bootPolicy','manual'),('mapper','bad;command'),('mountOptions','rw')]:
            bad=copy.deepcopy(base);bad['volumes'][0][field]=value
            with self.assertRaises(RuntimeError):storage.validate_volumes(bad)
        bad=copy.deepcopy(base);bad['volumes']*=2
        with self.assertRaises(RuntimeError):storage.validate_volumes(bad)
        mount={'target':'/srv/data','source':'/dev/mapper/customer-data','fstype':'ext4','uuid':v['fsUuid'],'options':'rw,nodev,nosuid'}
        storage.verify_mount(v,mount)
        with self.assertRaises(RuntimeError):storage.verify_mount(v,{**mount,'uuid':'foreign'})

    def test_new_machine_compatibility_is_not_developer_digest(self):
        contract=json.loads((Path(__file__).resolve().parents[1]/'deploy/host/release-compatibility.v1.json').read_text())
        combo=contract['combinations'][0]
        snapshot={'architecture':{'value':combo['architecture']},'os':combo['os'],'kernelRelease':{'value':combo['kernelRelease']},'foundation':{k:{'value':v} for k,v in combo['foundation'].items()},'packageState':{'digest':'different'},'serviceState':{'digest':'different'}}
        caps=dict(kvm=True,docker=True,cryptsetup=True,gpu=True)
        self.assertEqual(compatibility.compatible(snapshot,contract,caps)['status'],'compatible')
        self.assertEqual(compatibility.compatible(snapshot,contract,{**caps,'kvm':False})['failures'],['missing_kvm'])
        snapshot['foundation']['nvidiaDriver']['value']='unknown'
        self.assertIn('unsupported_foundation_combination',compatibility.compatible(snapshot,contract,caps)['failures'])

    def test_network_foreign_name_and_overlap(self):
        record={'installationId':'installation'};spec={'name':'customer-control','internal':True}
        actual={'Name':spec['name'],'Driver':'bridge','Internal':True,'Id':'owned','Labels':{},'IPAM':{'Config':[{'Subnet':'10.222.0.0/24'}]}}
        with self.assertRaises(ValueError):networks.verify(record,'phone-control',spec,actual)
        actual['Labels']={'com.teamaibox.installation-id':'installation','com.teamaibox.network-role':'phone-control'}
        self.assertEqual(networks.verify(record,'phone-control',spec,actual)['id'],'owned')
        self.assertTrue(networks.overlaps('10.222.0.0/24',['10.222.0.0/16']))
        self.assertFalse(networks.overlaps('10.222.0.0/24',['192.168.9.0/24']))

    def test_failed_network_prepare_cleans_only_new_empty_resources(self):
        record={'installationId':'fixture','networks':{r:{'name':'fixture-'+r,'internal':True} for r in networks.ENV}}
        calls=[]
        actual={'Id':'new-network','Name':'fixture-plugin-ingress','Driver':'bridge','Internal':True,'Containers':{},
            'Labels':{'com.teamaibox.installation-id':'fixture','com.teamaibox.network-role':'plugin-ingress'},'IPAM':{'Config':[{'Subnet':'10.222.1.0/24'}]}}
        def command(args):
            calls.append(args)
            if args[:3]==['docker','network','ls']:return ''
            if args[:2]==['ip','-j']:return '[{"dst":"192.168.40.0/24"}]'
            if args[:3]==['docker','network','create']:
                if args[-1]=='fixture-plugin-ingress':return 'new-network'
                raise RuntimeError('allocation failure')
            if args[:3]==['docker','network','inspect']:return json.dumps([actual])
            if args==['docker','network','rm','new-network']:return ''
            raise AssertionError(args)
        with self.assertRaises(RuntimeError):networks.prepare(record,command)
        self.assertEqual([c for c in calls if c[:3]==['docker','network','rm']],[['docker','network','rm','new-network']])

    def test_block_mapper_and_missing_mount_are_read_only_rejections(self):
        volume={'kind':'block','source':'/dev/customer-data','keyFile':'/secure/key','mountPoint':'/srv/data','mapper':'fixture','fsUuid':'filesystem'}
        with patch.object(storage,'run',side_effect=['device: /dev/customer-data','filesystem']) as run:
            storage.verify_mapper(volume)
            self.assertEqual([v.args[0][0] for v in run.call_args_list],['cryptsetup','blkid'])
        with patch.object(storage,'run',return_value='device: /dev/foreign'):
            with self.assertRaises(RuntimeError):storage.verify_mapper(volume)
        with self.assertRaises(RuntimeError):storage.verify_mount(volume,None)

    def test_media_failed_inspection_revokes_ready_state(self):
        writes=[]
        config=dict(nodeId='node',poolId='pool',stateFile='/state')
        with patch.object(media,'command',side_effect=RuntimeError('docker unavailable')):
            with self.assertRaises(RuntimeError):media.reconcile(config,['10.1.1.1'],[],lambda p,b:writes.append(json.loads(b)))
        self.assertEqual(writes[0]['status'],'preparing');self.assertEqual(writes[0]['runs'],{})
        with self.assertRaises(ValueError):media.rules({'run':{'containerAddress':'10.1.1.2','firstPort':8443,'lastPort':8492}},'10.1.1.1','eth0')

    def test_remote_database_identity_conflict_never_executes_sql(self):
        import appliance_database as db
        from types import SimpleNamespace
        with patch.dict(os.environ,{'TEAMAIBOX_POSTGRES_CONTAINER':'customer-db','PLATFORM_APPLIANCE_NODE_ID':'expected'},clear=True),patch.object(db.REMOTE,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps({'id':'a'*64,'name':'customer-db','nodeId':'foreign'}))) as run:
            with self.assertRaises(db.DeploymentError):db.remote_psql('delete from must_not_execute')
            self.assertEqual(run.call_count,1)
            self.assertNotIn('psql',run.call_args.args[0])

    def test_fresh_tls_identities_independent_and_repeat_preserves_keys(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(https.os,'chown'):
            first=Path(directory)/'a';second=Path(directory)/'b'
            https.initialize(first);https.initialize(second)
            self.assertNotEqual((first/'ca.crt').read_bytes(),(second/'ca.crt').read_bytes())
            original={n:(first/n).read_bytes() for n in ('ca.key','web.key','ca.crt','web.crt')}
            self.assertEqual(https.initialize(first)['status'],'unchanged')
            self.assertEqual(original,{n:(first/n).read_bytes() for n in original})

    def test_local_baseline_detects_subsequent_package_drift(self):
        combo=json.loads((Path(__file__).resolve().parents[1]/'deploy/host/release-compatibility.v1.json').read_text())['combinations'][0]
        snapshot={'schemaVersion':1,'collector':{'readOnly':True},'architecture':{'value':combo['architecture']},'os':combo['os'],'kernelRelease':{'value':combo['kernelRelease']},
            'foundation':{k:{'value':v} for k,v in combo['foundation'].items()},'packageState':{'digest':'first','count':1},
            'serviceState':{'digest':'services','count':1,'required':{'docker.service':{'active':'active','enabled':'enabled'}}},'configurationFingerprints':{}}
        recorded=compatibility.baseline(copy.deepcopy(snapshot),'fixture')
        self.assertTrue(host_drift.evaluate_snapshot(recorded,snapshot)['conforming'])
        snapshot['packageState']['digest']='changed'
        self.assertFalse(host_drift.evaluate_snapshot(recorded,snapshot)['conforming'])
        self.assertEqual(recorded['baseline']['packageState']['digest'],'first')

    def test_same_image_configuration_patch_is_not_silently_skipped(self):
        import appliance_delivery as delivery
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'phones.json';config.write_text('{"nodeId":"kept"}')
            patch_file=Path(directory)/'patch.json';patch_file.write_text('{"phones":{"hostMediaStateFile":"/config/state.json"}}')
            record={'references':{'phones':str(config)}}
            self.assertEqual(delivery.configuration_changes(record,patch_file),{'phones':{'hostMediaStateFile':'/config/state.json'}})
            self.assertEqual(json.loads(config.read_text()),{'nodeId':'kept'})
            config.write_text('{"nodeId":"kept","hostMediaStateFile":"/config/state.json"}')
            self.assertEqual(delivery.configuration_changes(record,patch_file),{})

    def test_same_image_interrupted_configuration_update_resumes(self):
        import appliance_delivery as delivery
        with tempfile.TemporaryDirectory() as directory:
            journal=Path(directory)/'job.json'
            journal.write_text(json.dumps({'status':'old_stopped','installationId':'local','role':'node-agent','imageId':'sha256:image'}))
            with patch.object(delivery,'load',return_value={'installationId':'local'}),patch.object(delivery,'resolve',return_value={'Image':'sha256:image'}),\
                 patch.object(delivery,'execute',return_value=json.dumps([{'Id':'sha256:image','Architecture':'arm64','Os':'linux'}])),\
                 patch.object(delivery,'resume',return_value={'status':'complete'}) as resume:
                self.assertEqual(delivery.replace('/installation','node-agent','same-image',journal),{'status':'complete'})
                resume.assert_called_once_with('/installation',journal)


if __name__=='__main__':unittest.main()
