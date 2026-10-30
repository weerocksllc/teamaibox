"""Bounded camera command framing, independent of the media library."""
import hashlib,io,sys,time,unittest,uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish'))
from phone_camera_client import request,execute,END,CameraInputError

class BrowserClientTests(unittest.TestCase):
    def setUp(self):
        self.config={k:str(uuid.uuid4()) for k in ('phoneId','ownerId','runId')};self.config['generation']=1
        self.grant={**self.config,**{k:str(uuid.uuid4()) for k in ('id','sourceId','sessionId')},'sourceKind':'browser'}
        self.raw=b'v=0\r\n';self.job=dict(action='browser-offer',grant=self.grant,deadline=int(time.time()*1000)+14000,
            sizeBytes=len(self.raw),sha256=hashlib.sha256(self.raw).hexdigest(),peerAddress='10.64.0.8')
        self.events=[];self.stopped=False
    def broker(self,value,frame=None):
        self.events.append(value['action'])
        if value['action']=='close':self.stopped=True
        return dict(state='stopped' if self.stopped else 'waiting',sourceId=self.grant['sourceId'],retainedFrameBytes=0)
    def browser(self,value):
        self.events.append('browser-'+value['action'])
        if value['action']=='offer':
            self.assertEqual(value['allowedAddresses'],['10.64.0.8']);self.assertEqual(value['offerSdp'],self.raw.decode())
            return dict(sourceId=self.grant['sourceId'],answerSdp='v=0\r\n',bindAddress='172.18.0.2')
        return dict(sourceId=self.grant['sourceId'],state='stopped' if self.stopped else 'waiting',retainedFrameBytes=0)
    def test_framed_offer_keeps_sdp_out_of_metadata_header(self):
        request(self.job,self.config)
        result=execute(self.job,io.BytesIO(self.raw+END),self.broker,browser_broker=self.browser)
        self.assertEqual(result['answerSdp'],'v=0\r\n');self.assertEqual(result['containerAddress'],'172.18.0.2')
        self.assertEqual(self.events,['status','browser-offer','status'])
    def test_invalid_framing_revokes_both_brokers(self):
        for raw in (self.raw[:-1]+END,self.raw+END+b'x',self.raw+b'x'+END):
            self.events=[]
            with self.assertRaises(CameraInputError):execute(self.job,io.BytesIO(raw),self.broker,browser_broker=self.browser)
            self.assertNotIn('browser-offer',self.events);self.assertEqual(self.events[-2:],['browser-close','close'])
    def test_offer_size_addresses_and_source_are_closed(self):
        for patch in ({'sizeBytes':65537},{'peerAddress':'127.0.0.1'},{'peerAddress':'camera.local'},
                      {'peerAddress':'8.8.8.8'},{'peerAddress':'169.254.169.254'},{'offerSdp':'private'},
                      {'grant':{**self.grant,'sourceKind':'image'}}):
            with self.assertRaises(CameraInputError):request({**self.job,**patch},self.config)
    def test_browser_close_clears_frame_and_waits_for_process_stop(self):
        job=dict(action='close',grant=self.grant,deadline=int(time.time()*1000)+4000)
        result=execute(job,io.BytesIO(),self.broker,browser_broker=self.browser)
        self.assertEqual(result['retainedFrameBytes'],0);self.assertEqual(self.events,['close','browser-close','status'])
    def test_ambiguous_decoder_offer_never_counts_as_active(self):
        def broken(value):
            if value['action']=='offer':raise CameraInputError('phone_camera_source_stopped')
            return self.browser(value)
        with self.assertRaises(CameraInputError):execute(self.job,io.BytesIO(self.raw+END),self.broker,browser_broker=broken)
        self.assertTrue(self.stopped)
    def test_browser_open_requires_installed_private_controller(self):
        job=dict(action='open',grant=self.grant,deadline=int(time.time()*1000)+4000,leaseExpiresAt=int(time.time()*1000)+4000)
        def missing(value):raise FileNotFoundError()
        with self.assertRaises(FileNotFoundError):execute(job,io.BytesIO(),self.broker,browser_broker=missing)
        self.assertEqual(self.events,[])

if __name__=='__main__':unittest.main()
