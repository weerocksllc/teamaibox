"""Offline wiring tests. Does not start Android or create a camera stream."""
import importlib.util
from pathlib import Path
import sys,types,unittest

SOURCE=Path('/opt/teamaibox/phone_network_start.py')
if not SOURCE.exists():SOURCE=Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish/phone_camera_browser_start.py'

class StartTests(unittest.TestCase):
    def test_existing_range_split_and_guest_hal_unchanged(self):
        from unittest.mock import patch
        def recipe(instance):
            return dict(mediaFirst=20000+(instance-21)*100,mediaLast=20049+(instance-21)*100)
        for instance in (21,22):
            def arguments(config):
                p=recipe(config['instance']);return ['--enable_tap_devices=true',f"--tcp_port_range={p['mediaFirst']}:{p['mediaLast']}",f"--udp_port_range={p['mediaFirst']}:{p['mediaLast']}"]
            base=types.SimpleNamespace(network_launch_arguments=arguments,PhoneError=RuntimeError)
            with patch.dict(sys.modules,{'phone_network_base':base,'phone_network':types.SimpleNamespace(recipe=recipe)}):
                spec=importlib.util.spec_from_file_location('candidate_start',SOURCE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
                args=module.camera_arguments(dict(instance=instance));first=recipe(instance)['mediaFirst']
                self.assertIn(f'--tcp_port_range={first}:{first+39}',args);self.assertIn(f'--udp_port_range={first}:{first+39}',args)
                self.assertIn('--camera=type=v4l2_emulated',args);self.assertEqual(len(args),5)
                module.original_arguments=lambda _:['--tcp_port_range=1:65535']
                with self.assertRaises(RuntimeError):module.camera_arguments(dict(instance=instance))

if __name__=='__main__':unittest.main()
