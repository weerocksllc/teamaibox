import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock

directory=Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish'
sys.path.insert(0,str(directory))
import phone_network_start as start
import phone_runtime


class NetworkStartTests(unittest.TestCase):
    def test_only_network_arguments_change(self):
        c={'instance':21,'phoneId':'fixture'}
        original=phone_runtime.launch_arguments(c)
        actual=start.network_launch_arguments(c)
        expected=[('--enable_tap_devices=true' if a=='--enable_tap_devices=false' else a) for a in original]
        self.assertEqual(actual,expected+['--enable_wifi=false','--ril_dns=1.1.1.1',
            '--tcp_port_range=20000:20049','--udp_port_range=20000:20049'])
        second=start.network_launch_arguments({'instance':22,'phoneId':'fixture'})
        self.assertEqual(second[-2:],['--tcp_port_range=20100:20149','--udp_port_range=20100:20149'])
        third=start.network_launch_arguments({'instance':23,'phoneId':'fixture'})
        self.assertEqual(third[-2:],['--tcp_port_range=20200:20249','--udp_port_range=20200:20249'])
        last_instance=21+(65535-20049)//100
        for instance in (20,last_instance+1,True,'21'):
            with self.subTest(instance=instance),self.assertRaises(ValueError):
                start.network_launch_arguments({'instance':instance,'phoneId':'fixture'})
        self.assertIn('--gpu_mode=guest_swiftshader',actual)
        self.assertIn('--memory_mb=4096',actual)
        self.assertIn('--data_policy=use_existing',actual)
        self.assertIn('--webrtc_sig_server_secure=true',actual)

    def test_init_cannot_keep_setup_privileges(self):
        args=start.drop_arguments([994,994])
        for value in ('--reuid=10001','--regid=10001','--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','--no-new-privs'):
            self.assertIn(value,args)
        self.assertEqual(args[-3:],['/usr/bin/python3','/opt/teamaibox/phone_network_start.py','serve'])
        self.assertIn('--groups=994,1000,1001',args)
        with self.assertRaises(phone_runtime.PhoneError):start.drop_arguments([0])

    def test_private_config_read_uses_owner_and_restores_init_uid(self):
        with mock.patch.object(start.os,'geteuid',return_value=0),mock.patch.object(start.os,'seteuid') as setuid, \
             mock.patch.object(start,'CONFIG') as config,mock.patch.object(start,'validate_config',return_value={'checked':True}):
            config.read_bytes.return_value=b'{}'
            self.assertEqual(start.read_config(),{'checked':True})
            self.assertEqual(setuid.call_args_list,[mock.call(10001),mock.call(0)])
            setuid.reset_mock();config.read_bytes.side_effect=PermissionError()
            with self.assertRaises(PermissionError):start.read_config()
            self.assertEqual(setuid.call_args_list,[mock.call(10001),mock.call(0)])


if __name__=='__main__':unittest.main()
