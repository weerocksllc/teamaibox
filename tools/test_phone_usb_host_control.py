"""Node-local selection and container binding; no live camera in unit tests."""
import copy
import json
from pathlib import Path
import sys
import time
import stat
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish'))
import phone_usb_host_control as h
from phone_usb_camera_devices import UsbDevice

def request():
    g={k:str(uuid.uuid4()) for k in ('id','sourceId','phoneId','ownerId','runId','sessionId')}
    g.update(generation=3,sourceKind='usb')
    return dict(action='start',nodeId=str(uuid.uuid4()),deadline=int(time.time()*1000)+14000,
                containerId='a'*64,grant=g,deviceId=str(uuid.uuid4()),attachmentId='b'*64)

def container(q):
    g=q['grant'];labels={'managed':'true','kind':'android-phone','node-id':q['nodeId'],
        'phone-id':g['phoneId'],'owner-identity-id':g['ownerId'],'phone-run-id':g['runId'],'phone-generation':str(g['generation'])}
    return dict(Id=q['containerId'],Name='/teamaibox-phone-'+g['runId'],
                Config=dict(Labels={'com.teamaibox.'+k:v for k,v in labels.items()}),
                State=dict(Running=True,Pid=123),HostConfig=dict(Privileged=False,PidMode=''))

class HostControlTests(unittest.TestCase):
    def test_device_descriptors_without_network_or_fuser(self):
        target=SimpleNamespace(st_mode=stat.S_IFCHR,st_rdev=20736)
        with tempfile.TemporaryDirectory() as tmp,patch.object(h.os,'stat',return_value=target):
            proc=Path(tmp);self.assertTrue(h.device_free('/dev/video0',proc))
            (proc/'123'/'fd').mkdir(parents=True);(proc/'123'/'fd'/'4').touch()
            with patch.object(Path,'stat',return_value=target):self.assertFalse(h.device_free('/dev/video0',proc))
            with patch.object(Path,'stat',side_effect=FileNotFoundError):self.assertTrue(h.device_free('/dev/video0',proc))
            with patch.object(Path,'stat',side_effect=PermissionError):
                with self.assertRaisesRegex(h.UsbCameraError,'device_check_failed'):h.device_free('/dev/video0',proc)
        with self.assertRaisesRegex(h.UsbCameraError,'device_invalid'):h.device_free('--anything')
    def test_closed_request_never_accepts_path_or_shell(self):
        q=request();self.assertEqual(h.validate_request(q),q)
        for change in ({'path':'/dev/video0'},{'command':'anything'},{'target':'/tmp/other'},
                       {'containerId':'../other'},{'deadline':0},{'action':'stop'}):
            with self.subTest(change=change),self.assertRaises(h.UsbCameraError):h.validate_request(q|change)
        with self.assertRaises(h.UsbCameraError):h.closed_json('{"action":"inventory","action":"start"}')

    def test_grant_exact_run_and_identity(self):
        q=request()
        for key in ('id','sourceId','phoneId','ownerId','runId','sessionId'):
            bad=copy.deepcopy(q);bad['grant'][key]='bad'
            with self.subTest(key=key),self.assertRaises(h.UsbCameraError):h.validate_request(bad)
        for change in ({'sourceKind':'browser'},{'generation':True},{'generation':0},{'path':'other'}):
            bad=copy.deepcopy(q);bad['grant'].update(change)
            with self.subTest(change=change),self.assertRaises(h.UsbCameraError):h.validate_request(bad)

    def test_container_owner_node_run_and_generation_match(self):
        q=request();value=container(q);self.assertEqual(h.validate_container(value,q),123)
        for field in ('phone-id','owner-identity-id','node-id','phone-run-id','phone-generation','kind'):
            bad=copy.deepcopy(value);bad['Config']['Labels']['com.teamaibox.'+field]='other'
            with self.subTest(field=field),self.assertRaises(h.UsbCameraError):h.validate_container(bad,q)
        for change in ({'Id':'b'*64},{'Name':'other'},{'State':dict(Running=False,Pid=123)},
                       {'HostConfig':dict(Privileged=True,PidMode='')},{'HostConfig':dict(Privileged=False,PidMode='host')}):
            with self.subTest(change=change),self.assertRaises(h.UsbCameraError):h.validate_container(value|change,q)

    def setup_control(self):
        q=request();d=UsbDevice(q['nodeId'],q['deviceId'],q['attachmentId'],'Camera','/dev/video0',20736,1,('MJPG','YUYV'))
        starts=[];ctl=h.Control(q['nodeId'],discover=lambda n:([d],[]),start=lambda v,dev:starts.append((v,dev)) or {'state':'receiving'})
        return q,d,ctl,starts

    def test_inventory_is_metadata_without_host_path_or_capture(self):
        q,d,ctl,starts=self.setup_control()
        value=ctl.handle({k:q[k] for k in ('nodeId','deadline')}|dict(action='inventory'))
        self.assertEqual(value,dict(nodeId=q['nodeId'],data=[d.public()]))
        self.assertNotIn('/dev',json.dumps(value));self.assertEqual(starts,[])

    def test_only_same_node_current_attachment_opens(self):
        q,d,ctl,starts=self.setup_control()
        for change in ({'nodeId':str(uuid.uuid4())},{'deviceId':str(uuid.uuid4())},{'attachmentId':'c'*64}):
            with self.subTest(change=change),self.assertRaises(h.UsbCameraError):ctl.handle(q|change)
        self.assertEqual(starts,[])
        self.assertEqual(ctl.handle(q),dict(state='receiving'));self.assertEqual(starts,[(q,d)])

    def test_inventory_failure_does_not_select_another_camera(self):
        q,d,ctl,starts=self.setup_control();ctl.discover=lambda n:([d],[dict(errorCode='permission')])
        with self.assertRaises(h.UsbCameraError):ctl.handle(q)
        self.assertEqual(starts,[])

if __name__=='__main__':unittest.main()
