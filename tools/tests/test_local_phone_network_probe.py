import importlib.util
from pathlib import Path
import unittest

SPEC=importlib.util.spec_from_file_location('probe',Path(__file__).parents[1]/'check_local_phone_network.py')
probe=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class PhoneNetworkProbeTests(unittest.TestCase):
    def test_counts_rule_and_default_policy_drops(self):
        result=probe.counters(':FORWARD DROP [2:120]\n[3:180] -A INPUT -i cvd-mtap-21 -j REJECT')
        self.assertEqual(result['policy:FORWARD:DROP'],2)
        self.assertEqual(result['-A INPUT -i cvd-mtap-21 -j REJECT'],3)

    def test_timeout_alone_never_proves_control_isolation(self):
        rules='-A FORWARD -s 192.168.246.2/32 -i cvd-mtap-21 -o eth0 -j PHONE_PUBLIC'
        start={'policy:FORWARD:DROP':2}
        self.assertFalse(probe.control_forward_drop(start,start,[{'dev':'eth1'}],rules))
        end={'policy:FORWARD:DROP':3}
        self.assertTrue(probe.control_forward_drop(start,end,[{'dev':'eth1'}],rules))
        self.assertFalse(probe.control_forward_drop(start,end,[{'dev':'eth0'}],rules))
        self.assertFalse(probe.control_forward_drop(start,end,[],rules))
        self.assertFalse(probe.control_forward_drop(start,end,[{'dev':'eth1'}],rules+'\n'+rules.replace('eth0','eth1')))


if __name__=='__main__':unittest.main()
