"""Real HTTP/subprocess checks against the candidate controller, no GPU/model."""
from concurrent.futures import ThreadPoolExecutor
import http.client
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

MODEL = 'hunyuanocr-1.5-bf16-dflash'


def request(path, body=None):
    connection = http.client.HTTPConnection('127.0.0.1', 8000, timeout=20)
    try:
        connection.request('GET' if body is None else 'POST', path,
            None if body is None else json.dumps(body), {'Content-Type': 'application/json'})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


with tempfile.TemporaryDirectory(prefix='ocr-startup-fixture-') as directory:
    root = Path(directory)
    for name in ['model', 'draft']:
        (root / name).touch()
    env = dict(os.environ, INFERENCE_MODE='vllm-dflash',
        TEAMAIBOX_STARTUP_FIXTURE_ROOT=directory, TEAMAIBOX_HUNYUAN_ENGINE_PYTHON=sys.executable,
        TEAMAIBOX_HUNYUAN_ENGINE_SCRIPT='/probe/fake_engine.py',
        TEAMAIBOX_HUNYUAN_MODEL_MARKER=str(root / 'model'),
        TEAMAIBOX_HUNYUAN_DFLASH_MARKER=str(root / 'draft'),
        TEAMAIBOX_HUNYUAN_PREPARE_TIMEOUT_SECONDS='15')
    server = subprocess.Popen([sys.executable, '/opt/teamaibox/ocr-worker/managed_dflash_server.py'],
        env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    checks = []
    try:
        for _ in range(50):
            assert server.poll() is None, 'controller_exited'
            try:
                if request('/health')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(0.1)
        assert request('/health')[1]['loaded'] is False
        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(lambda _: request('/v1/models/prepare', {'model': MODEL}), range(2)))
        assert all(status == 200 and body['loaded'] for status, body in results)
        assert len((root / 'starts').read_text().splitlines()) == 1
        assert sorted(body['warm_reuse'] for _, body in results) == [False, True]
        checks.append('two_http_prepares_share_one_actual_process')
        assert request('/v1/models/prepare', {'model': MODEL})[1]['warm_reuse'] is True
        assert len((root / 'starts').read_text().splitlines()) == 1
        checks.append('warm_prepare_does_not_restart')
        assert request('/v1/models/unload', {'model': MODEL})[0] == 200
        assert request('/health')[1]['loaded'] is False
        assert request('/diagnostics/startup')[1] == dict(phase='idle', exitCode=None, reason=None)
        checks.append('unload_resets_health_and_diagnostic')
        (root / 'fail').touch()
        assert request('/v1/models/prepare', {'model': MODEL})[0] == 503
        expected = dict(phase='failed', exitCode=7, reason='cuda_memory_exhausted')
        for _ in range(20):
            diagnostic = request('/diagnostics/startup')[1]
            if diagnostic == expected:
                break
            time.sleep(0.1)
        assert diagnostic == expected
        checks.append('failed_process_exit_and_redacted_synthetic_diagnostic')
        (root / 'fail').unlink()
        assert request('/v1/models/prepare', {'model': MODEL})[0] == 200
        assert len((root / 'starts').read_text().splitlines()) == 3
        assert request('/diagnostics/startup')[1] == dict(phase='ready', exitCode=None, reason=None)
        checks.append('fresh_prepare_recovers_after_failure')
        assert request('/v1/models/unload', {'model': MODEL})[0] == 200
        assert request('/health')[1]['loaded'] is False
        checks.append('final_exact_engine_cleanup')
        print(json.dumps(dict(status='passed', tests=checks, engine='synthetic-cpu-only',
            gpuUsed=False, modelLoaded=False, productionDeployed=False,
            sources={name:'sha256:' + hashlib.sha256(Path('/opt/teamaibox/ocr-worker', name).read_bytes()).hexdigest()
                for name in ['managed_dflash_server.py', 'managed_dflash_engine.py']})))
    finally:
        try:
            request('/v1/models/unload', {'model': MODEL})
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
