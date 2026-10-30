"""Source contracts only. Real Android qualification is separately recorded."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('phone_runtime', ROOT/'deploy/android/cuttlefish/phone_runtime.py')
PHONE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PHONE)


def config():
    return dict(version=1, buildId='16102939', instance=21, generation=1,
                **{k:str(uuid.uuid4()) for k in ('phoneId','ownerId','volumeId','runId')})


class RuntimeTests(unittest.TestCase):
    def test_closed_declaration_and_generation(self):
        value=config()
        self.assertEqual(PHONE.validate_config(value),value)
        for changes in ({'path':'/etc'}, {'version':True}, {'generation':0}, {'generation':True},
                        {'instance':1}, {'ownerId':'../../escape'}, {'buildId':'other'}):
            with self.subTest(changes=changes), self.assertRaises(PHONE.PhoneError): PHONE.validate_config(value|changes)
        with self.assertRaises(PHONE.PhoneError): PHONE.closed_json('{"version":1,"version":1}')

    def test_first_boot_preserves_data_and_refuses_other_owner(self):
        with tempfile.TemporaryDirectory() as folder:
            data=Path(folder)/'phone'; data.mkdir(); base=Path(folder)/'base'; base.mkdir()
            for name in PHONE.VBMETA: (base/(name+'.img')).write_bytes(b'AVB-fixture')
            (data/'.runtime.lock').touch(); value=config(); calls=[]
            def initialize(args, **kwargs):
                calls.append(args)
                with Path(args[-1]).open('wb') as output: output.truncate(8*1024**3)
                return subprocess.CompletedProcess(args,0)
            PHONE.ensure_private_data(value, base=base, data=data, command=initialize)
            (data/'exchange/retained').write_text('synthetic-file')
            PHONE.ensure_private_data(value|{'generation':2,'runId':str(uuid.uuid4())}, base=base, data=data, command=initialize)
            self.assertEqual(len(calls),1)
            self.assertEqual((data/'exchange/retained').read_text(),'synthetic-file')
            self.assertEqual((base/'vbmeta.img').read_bytes(),b'AVB-fixture')
            self.assertEqual((data/'boot-metadata/vbmeta.img').stat().st_size,65536)
            with self.assertRaises(PHONE.PhoneError): PHONE.ensure_private_data(value|{'ownerId':str(uuid.uuid4())}, data=data, command=initialize)

    def test_instance_capacity_is_not_a_two_phone_product_limit(self):
        for instance in (23, 100, 475):
            self.assertEqual(PHONE.validate_config(config()|{'instance':instance})['instance'],instance)
        with self.assertRaises(PHONE.PhoneError): PHONE.validate_config(config()|{'instance':476})

    def test_unbound_data_and_symlinks_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            data=Path(folder); (data/'userdata.img').write_bytes(b'old-phone')
            with self.assertRaises(PHONE.PhoneError): PHONE.ensure_private_data(config(), data=data)
        with tempfile.TemporaryDirectory() as folder:
            data=Path(folder); value=config()
            (data/'.phone-data.json').write_text(json.dumps({k:value[k] for k in ('phoneId','ownerId','volumeId','buildId')}))
            (data/'home').symlink_to('/tmp')
            with self.assertRaises(PHONE.PhoneError): PHONE.ensure_private_data(value, data=data)

    def test_fixed_offline_non_gpu_configuration(self):
        args=PHONE.launch_arguments(config())
        for flag in ('--memory_mb=4096','--cpus=4','--enable_modem_simulator=true',
                     '--gpu_mode=guest_swiftshader','--webrtc_sig_server_secure=true',
                     '--data_policy=use_existing','--resume=true','--enable_tap_devices=false'):
            self.assertIn(flag,args)
        self.assertFalse(any('adb_port=' in item or 'host' == item for item in args))

    def test_media_uses_actual_upstream_id_list_not_object_list(self):
        self.assertTrue(PHONE.media_device_available(['phone-exact'],'phone-exact'))
        for value in ([],['another-phone'],['phone-exact','another-phone'],[{'device_id':'phone-exact'}]):
            self.assertFalse(PHONE.media_device_available(value,'phone-exact'))

    def test_shutdown_requires_android_flush_exit_and_successful_cleanup(self):
        value=PHONE.Runtime(config()); value.launched=True
        with patch.object(value,'adb',return_value=subprocess.CompletedProcess([],0,'')) as adb, \
             patch.object(value,'command',return_value=subprocess.CompletedProcess([],0,'')), \
             patch.object(PHONE,'shutdown_process_summary',return_value=[]), \
             patch.object(PHONE,'android_processes',side_effect=[[123],[]]), \
             patch.object(PHONE,'guest_processes',return_value=[]), \
             patch.object(value,'save'):
            value.stop()
            self.assertTrue(value.status['cleanShutdown'])
            self.assertEqual(adb.call_args_list[0].args,('shell','sync'))
            self.assertEqual(adb.call_args_list[1].args,('shell','setprop','sys.powerctl','shutdown'))
            self.assertTrue(value.status['shutdownEvidence']['guestExitedBeforeRuntimeStop'])
        value=PHONE.Runtime(config()); value.launched=True
        with patch.object(value,'adb',side_effect=subprocess.TimeoutExpired('adb',15)), \
             patch.object(PHONE,'shutdown_process_summary',return_value=[]), \
             patch.object(PHONE,'android_processes',return_value=[123]), \
             patch.object(PHONE,'guest_processes',return_value=[123]), \
             patch.object(value,'command',return_value=subprocess.CompletedProcess([],0,'')), patch.object(value,'save'):
            value.stop(); self.assertFalse(value.status['cleanShutdown'])

    def test_guest_process_observation_is_container_local_and_ignores_zombies(self):
        with tempfile.TemporaryDirectory() as folder:
            proc=Path(folder)
            for pid,name,state in ((100,'crosvm','S'),(101,'crosvm','Z'),(102,'adb','S')):
                entry=proc/str(pid);entry.mkdir();(entry/'comm').write_text(name+'\n');(entry/'stat').write_text(str(pid)+' ('+name+') '+state+' 1 2 3')
            self.assertEqual(PHONE.guest_processes(proc),[100])

    def test_cleanup_retries_transient_failure_but_requires_success_and_no_guest(self):
        value=PHONE.Runtime(config())
        with patch.object(value,'command',side_effect=[subprocess.CompletedProcess([],4,''),subprocess.CompletedProcess([],0,'')]) as command, \
             patch.object(PHONE,'guest_processes',return_value=[]), patch.object(PHONE.time,'sleep'):
            self.assertTrue(value.cleanup_runtime())
            self.assertEqual(command.call_count,2)
            self.assertEqual([x['exitCode'] for x in value.status['shutdownDiagnostics']['runtimeCleanup']],[4,0])
        for exit_code,guests in ((4,[]),(0,[123])):
            value=PHONE.Runtime(config())
            with patch.object(value,'command',return_value=subprocess.CompletedProcess([],exit_code,'')) as command, \
                 patch.object(PHONE,'guest_processes',return_value=guests), patch.object(PHONE.time,'sleep'):
                self.assertFalse(value.cleanup_runtime())
                self.assertEqual(command.call_count,3)

    def test_cleanup_records_racing_proc_error_without_disclosing_paths(self):
        value=PHONE.Runtime(config())
        with patch.object(value,'command',return_value=subprocess.CompletedProcess([],0,'')), \
             patch.object(PHONE,'guest_processes',side_effect=[ProcessLookupError(3,'private argument'),[]]), patch.object(PHONE.time,'sleep'):
            self.assertTrue(value.cleanup_runtime())
            first=value.status['shutdownDiagnostics']['runtimeCleanup'][0]
            self.assertEqual(first['errno'],3)
            self.assertNotIn('private',str(first))

    def test_android_shutdown_does_not_wait_for_openwrt_network_vm(self):
        rows=[{'pid':100,'role':'run','parentRole':'process_restart','controlSockets':['crosvm_control.sock']},
              {'pid':200,'role':'run','parentRole':'process_restart','controlSockets':['ap_control.sock']}]
        with patch.object(PHONE,'shutdown_process_summary',return_value=rows):self.assertEqual(PHONE.android_processes(),[100])
        with patch.object(PHONE,'shutdown_process_summary',return_value=rows[1:]):self.assertEqual(PHONE.android_processes(),[])


if __name__ == '__main__': unittest.main()
