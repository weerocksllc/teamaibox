"""CPU-only reproduction of the old controller's overlapping prepare restart."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def request(path, body=None):
    connection = http.client.HTTPConnection('127.0.0.1', 8000, timeout=40)
    try:
        connection.request('GET' if body is None else 'POST', path,
            None if body is None else json.dumps(body), {'Content-Type': 'application/json'})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def await_condition(check, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.05)
    raise AssertionError('fixture_condition_timeout')


with tempfile.TemporaryDirectory(prefix='ocr-old-controller-') as directory:
    root = Path(directory)
    for name in ['model', 'draft']:
        (root / name).touch()
    env = dict(os.environ, INFERENCE_MODE='vllm-dflash',
        TEAMAIBOX_STARTUP_FIXTURE_ROOT=directory,
        TEAMAIBOX_HUNYUAN_ENGINE_PYTHON=sys.executable,
        TEAMAIBOX_HUNYUAN_ENGINE_SCRIPT='/probe/fake_engine.py',
        TEAMAIBOX_HUNYUAN_MODEL_MARKER=str(root / 'model'),
        TEAMAIBOX_HUNYUAN_DFLASH_MARKER=str(root / 'draft'),
        TEAMAIBOX_HUNYUAN_PREPARE_TIMEOUT_SECONDS='35')
    server = subprocess.Popen([sys.executable, '/opt/teamaibox/ocr-worker/managed_dflash_server.py'],
        env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        def ready():
            assert server.poll() is None, 'controller_exited'
            try:
                return request('/health')[0] == 200
            except OSError:
                return False
        await_condition(ready)
        with ThreadPoolExecutor(2) as executor:
            first = executor.submit(request, '/v1/models/prepare', {'model': 'hunyuanocr-1.5-bf16-dflash'})
            await_condition(lambda: (root / 'starts').exists())
            second = executor.submit(request, '/v1/models/prepare', {'model': 'hunyuanocr-1.5-bf16-dflash'})
            responses = [first.result(), second.result()]
        starts = len((root / 'starts').read_text().splitlines())
        assert starts == 2, 'expected_old_controller_restart_not_observed'
        print(json.dumps(dict(status='passed', reproducedDefect='overlapping_prepare_restarts_loading_engine',
            prepareRequests=2, actualEngineStarts=starts, responseStatuses=[x[0] for x in responses],
            engine='synthetic-cpu-only', gpuUsed=False, modelLoaded=False,
            pastBootFailureRootCauseProven=False,
            controllerDigest='sha256:' + hashlib.sha256(Path('/opt/teamaibox/ocr-worker/managed_dflash_server.py').read_bytes()).hexdigest())))
    finally:
        try:
            request('/v1/models/unload', {'model': 'hunyuanocr-1.5-bf16-dflash'})
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
