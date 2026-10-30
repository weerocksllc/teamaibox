from pathlib import Path
import socket
import sys
import unittest
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish'))
from phone_udp_host_control import validate_request,bind_socket
from phone_udp_ingress import UdpPolicy,UdpIngressError

class HandoffTests(unittest.TestCase):
    def value(self):
        grant={k:str(uuid.uuid4()) for k in ('id','sourceId','phoneId','ownerId','runId','sessionId')}
        return dict(action='udp-start',nodeId=str(uuid.uuid4()),containerId='a'*64,deadline=11000,
            grant={**grant,'sourceKind':'udp','generation':3},
            policy=dict(listenAddress='127.0.0.1',listenPort=35000,allowedSources=['127.0.0.1/32']))

    def test_request_is_exact_current_and_udp_only(self):
        value=self.value();self.assertEqual(validate_request(value,10000),value)
        for field,new in [('action','start'),('deadline',10000),('deadline',26000),('containerId','other')]:
            with self.assertRaises(UdpIngressError):validate_request({**value,field:new},10000)
        with self.assertRaises(UdpIngressError):validate_request({**value,'url':'anything'},10000)
        for kind in ('usb','image','video','browser'):
            with self.assertRaises(UdpIngressError):validate_request({**value,'grant':{**value['grant'],'sourceKind':kind}},10000)

    def test_port_is_exclusive_and_released(self):
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as selected:
            selected.bind(('127.0.0.1',0));port=selected.getsockname()[1]
        policy=UdpPolicy.from_admin(dict(listenAddress='127.0.0.1',listenPort=port,allowedSources=['127.0.0.1/32']))
        with bind_socket(policy) as first:
            self.assertEqual(first.getsockname(),('127.0.0.1',port));self.assertFalse(first.get_inheritable())
            with self.assertRaises(UdpIngressError):bind_socket(policy)
        with bind_socket(policy) as reopened:self.assertEqual(reopened.getsockname(),('127.0.0.1',port))

if __name__=='__main__':unittest.main()
