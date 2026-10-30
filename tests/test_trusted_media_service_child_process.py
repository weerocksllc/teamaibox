"""Service-lifetime Linux creator thread keeps the parent-death protection."""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time
import unittest


@unittest.skipUnless(sys.platform == "linux", "Linux parent-death contract")
class ServiceChildProcessTest(unittest.TestCase):
    def test_service_crash_still_terminates_a_persistent_thread_child(self):
        # This is only a process-lifecycle fixture, never Apple media proof.
        child = """import ctypes,os,signal,sys,time
parent=int(sys.argv[1])
assert ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)==0 and os.getppid()==parent
print('ready',flush=True)
time.sleep(30)
"""
        driver_code = """import json,os,subprocess,sys,time
from services.trusted_media_service.service_child_process import spawn_service_child
p=spawn_service_child([sys.executable,'-c',sys.argv[1],str(os.getpid())],stdout=subprocess.PIPE)
assert p.stdout.readline()==b'ready\\n'
print(json.dumps({'child':p.pid}),flush=True)
time.sleep(30)
"""
        driver = subprocess.Popen([sys.executable, "-c", driver_code, child],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            self.assertTrue(select.select([driver.stdout], [], [], 5)[0])
            pid = json.loads(driver.stdout.readline())["child"]
            driver.kill()
            driver.wait(timeout=3)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                status = Path(f"/proc/{pid}/stat")
                if not status.exists() or status.read_text().split(") ", 1)[1].startswith("Z "):
                    break
                time.sleep(0.02)
            else:
                self.fail("owned child survived service death")
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass
            print(json.dumps({"serviceParentDeathProtectionObserved": True}), flush=True)
        finally:
            if driver.poll() is None:
                driver.kill()
                driver.wait(timeout=3)
            driver.stdout.close()
