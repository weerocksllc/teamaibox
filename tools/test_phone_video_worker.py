"""Real Linux subprocess/Unix handoff/codec test, not Android acceptance."""
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import unittest
import uuid

sys.path.insert(0,'/opt/teamaibox')
from phone_camera_client import control, video_control, execute, END
from phone_camera_input import receive, CameraInputError
from test_phone_video_camera import generate


def until(check,seconds=5):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if check():return
        time.sleep(.025)
    raise AssertionError('bounded_wait_failed')


class VideoWorkerTests(unittest.TestCase):
    def setUp(self):
        assert os.getuid()==10001
        self.directory=Path('/tmp/phone-camera-input');self.directory.mkdir(mode=0o700)
        self.config={k:str(uuid.uuid4()) for k in ('phoneId','ownerId','volumeId','runId')}
        self.config.update(version=1,generation=1,buildId='16102939',instance=21)
        self.path=Path('/run/phone/config.json');self.path.write_text(json.dumps(self.config))
        self.grant={k:self.config[k] for k in ('phoneId','ownerId','runId','generation')}
        self.grant.update({k:str(uuid.uuid4()) for k in ('id','sourceId','sessionId')},sourceKind='video')
        self.children=[]
        self.broker=self.launch('phone_camera_input.py');self.controller=self.launch('phone_video_camera_control.py')
        until(lambda:all((self.directory/f).exists() for f in ('control.sock','frames.sock','video.sock')))
    def launch(self,name):
        child=subprocess.Popen(['/usr/bin/python3','-B','/opt/teamaibox/'+name],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.children.append(child);return child
    def tearDown(self):
        try:video_control({'action':'close','grant':self.grant})
        except Exception:pass
        for child in reversed(self.children):
            if child.poll() is None:child.terminate()
            try:child.wait(2)
            except subprocess.TimeoutExpired:child.kill();child.wait(2)
        for name in ('control.sock','frames.sock','video.sock','last-source-exit.json'):(self.directory/name).unlink(missing_ok=True)
        self.directory.rmdir();self.path.unlink()
    def start(self,loop=False,data=None):
        data=generate(frames=30) if data is None else data
        control({'action':'open','grant':self.grant,'leaseExpiresAt':int(time.time()*1000)+4000})
        return execute({'action':'video','grant':self.grant,'deadline':int(time.time()*1000)+14000,
            'sizeBytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'loop':loop},io.BytesIO(data+END))
    def state(self):return control({'action':'status','grant':self.grant})
    def frame(self):
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(1);sock.connect(str(self.directory/'frames.sock'));sock.sendall(b'F')
            return receive(sock,struct.unpack('!I',receive(sock,4))[0])
    def worker(self):
        raw=Path(f'/proc/{self.controller.pid}/task/{self.controller.pid}/children')
        # Linux tracks children by creating thread, so inspect all live TIDs.
        pids=set()
        for path in raw.parent.parent.glob('*/children'):
            try:pids.update(int(v) for v in path.read_text().split())
            except FileNotFoundError:pass
        found=[]
        for pid in pids:
            try:
                if b'/opt/teamaibox/phone_video_camera_worker.py' in Path(f'/proc/{pid}/cmdline').read_bytes():found.append(pid)
            except FileNotFoundError:pass
        self.assertEqual(len(found),1)
        return found[0]
    def test_actual_handoff_dynamic_frames_and_end_clear(self):
        neutral=self.frame();self.assertEqual(self.start()['state'],'receiving')
        frames=[]
        for _ in range(8):frames.append(hashlib.sha256(self.frame()).hexdigest());time.sleep(.08)
        self.assertGreaterEqual(len(set(frames)),5)
        until(lambda:self.state()['state']=='stopped',4)
        self.assertEqual(self.frame(),neutral)
        until(lambda:video_control({'action':'status','grant':self.grant})['workerRunning'] is False)
        diagnostic=json.loads((self.directory/'last-source-exit.json').read_text())
        self.assertEqual(set(diagnostic),{'sourceId','reason','frames','errorType','watchErrorType','sourceDiagnostic'})
        self.assertEqual(diagnostic['sourceId'],self.grant['sourceId'])
        self.assertGreater(diagnostic['frames'],0)
    def test_initialization_diagnostic_does_not_log_exception_text(self):
        from phone_video_camera_worker import record_exit
        record_exit({'grant':self.grant},None,RuntimeError('private image path /phone/private.jpg'))
        diagnostic=json.loads((self.directory/'last-source-exit.json').read_text())
        self.assertEqual(diagnostic['reason'],'phone_camera_runtime_unavailable')
        self.assertEqual(diagnostic['errorType'],'RuntimeError')
        self.assertNotIn('private',json.dumps(diagnostic))
        record_exit({'grant':self.grant},None,CameraInputError('phone_camera_source_stopped'))
        self.assertEqual(json.loads((self.directory/'last-source-exit.json').read_text())['reason'],'phone_camera_source_stopped')
    def test_parent_liveness_is_safe_from_capture_and_watch_threads(self):
        from phone_video_camera_worker import parent_is_alive
        # The suite itself is PID 1 in its test container (parent is PID 0).
        # Use our own live pidfd for the concurrent-read test; separate tests
        # below and supervisor-loss exercise real process exit/reparenting.
        parent=os.getppid();fd=os.pidfd_open(os.getpid())
        gate=threading.Barrier(4);errors=[]
        def check():
            gate.wait()
            try:
                for _ in range(20000):
                    if not parent_is_alive(parent,fd):raise AssertionError('live_parent_lost')
            except Exception as error:errors.append(type(error).__name__)
        threads=[threading.Thread(target=check) for _ in range(4)]
        try:
            for t in threads:t.start()
            for t in threads:t.join(10)
            self.assertFalse(any(t.is_alive() for t in threads))
            self.assertEqual(errors,[])
            self.assertFalse(parent_is_alive(parent+1,fd))
        finally:os.close(fd)
        child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(.05)'])
        fd=os.pidfd_open(child.pid)
        try:
            child.wait(2)
            self.assertFalse(parent_is_alive(parent,fd))
        finally:os.close(fd)
    def test_loop_keeps_frames_with_renewal_then_stop_reaps_decoder(self):
        neutral=self.frame();self.start(loop=True,data=generate(frames=6));pid=self.worker()
        for _ in range(5):
            time.sleep(.35);control({'action':'renew','grant':self.grant,'leaseExpiresAt':int(time.time()*1000)+4000})
            self.assertEqual(self.state()['state'],'receiving')
        result=video_control({'action':'close','grant':self.grant})
        self.assertEqual(result['retainedFrameBytes'],0);self.assertEqual(self.frame(),neutral)
        until(lambda:not Path(f'/proc/{pid}').exists())
    def test_decoder_killed_clears_old_frame_without_restarting_broker(self):
        neutral=self.frame();self.start(loop=True);pid=self.worker();os.kill(pid,signal.SIGKILL)
        until(lambda:self.state()['state']=='stopped');self.assertEqual(self.frame(),neutral)
        self.assertIsNone(self.broker.poll());self.assertIsNone(self.controller.poll())
    def test_supervisor_loss_releases_decoder_even_without_rpc(self):
        neutral=self.frame();self.start(loop=True);pid=self.worker();self.controller.kill();self.controller.wait(2)
        until(lambda:self.state()['state']=='stopped')
        self.assertEqual(self.frame(),neutral)
        def dead():
            try:return Path(f'/proc/{pid}/stat').read_text().split()[2]=='Z'
            except FileNotFoundError:return True
        until(dead,2)  # PID 1 in the test container owns orphan reaping.
    def test_invalid_h264_is_rejected_and_frame_stays_neutral(self):
        neutral=self.frame()
        with self.assertRaisesRegex(CameraInputError,'video_unsupported'):
            self.start(data=b'\x00\x00\x00\x18ftypisom'+bytes(12))
        self.assertEqual(self.state()['state'],'stopped');self.assertEqual(self.frame(),neutral)


if __name__=='__main__':unittest.main()
