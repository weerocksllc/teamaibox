#!/usr/bin/env python3
"""Observe the real memory protection of one disposable newest phone.

No workload control commands. The existing original phone is watched only;
allocations are released as soon as the disposable phone enters protection.
Run inside a fixed, no-network, no-swap container with read-only host counters
and the Node Agent journal. Never run against arbitrary or older phones.
"""
import json
import os
from pathlib import Path
import signal
import sys
import time
import uuid

from phone_pressure_fixture import GIB, FLOOR, TARGET, MAX_SECONDS, pressure_action, sample

MAX_BYTES = 20 * GIB


def action(current, initial, target, original, allocated, elapsed):
    saved = current['phones'][original]
    if saved != initial['phones'][original]:
        return 'original_phone_changed'
    test = current['phones'][target]
    if test['protectionReason']:
        return 'target_protected'
    if test['phase'] != 'running':
        return 'target_unexpected_state'
    if current['available'] < FLOOR:
        return 'safety_floor'
    if elapsed >= MAX_SECONDS:
        return 'deadline'
    if current['available'] <= TARGET:
        return 'hold'
    if allocated >= MAX_BYTES:
        return 'allocation_cap'
    return 'allocate'


def main(target, original):
    assert target != original and all(str(uuid.UUID(v)) == v for v in (target, original))
    assert os.getuid() == 10001
    assert int(Path('/sys/fs/cgroup/memory.max').read_text()) == 32 * GIB
    assert Path('/sys/fs/cgroup/memory.swap.max').read_text().strip() == '0'
    journal = json.loads(Path('/phone-journal/phones.json').read_text())['phones']
    running = {k: v for k,v in journal.items() if v.get('phase') == 'running'}
    assert set(running) == {target, original}, 'unexpected_running_phone'
    assert running[target]['startedAtUnixMs'] > running[original]['startedAtUnixMs'], 'target_must_be_newest'
    initial = sample([target, original])
    assert initial['available'] >= 22 * GIB and initial['psi'] < 1
    assert all(v['phase'] == 'running' and not v['protectionReason'] for v in initial['phones'].values())
    def alarm(*_):
        raise TimeoutError('independent_deadline')
    signal.signal(signal.SIGALRM, alarm)
    signal.alarm(MAX_SECONDS + 5)
    blocks, readings = [], []
    allocated, reason = 0, 'unstarted'
    started = time.monotonic()
    try:
        while True:
            value = sample([target, original])
            elapsed = time.monotonic() - started
            value.update(seconds=round(elapsed, 3), allocatedBytes=allocated)
            readings.append(value)
            decision = action(value, initial, target, original, allocated, elapsed)
            if decision not in ('allocate', 'hold'):
                reason = decision
                break
            pressure = pressure_action(readings)
            if pressure == 'safety-pressure':
                reason = pressure
                break
            if pressure == 'hold':
                decision = 'hold'
            if decision == 'allocate':
                block = bytearray(16 * 1024 ** 2)
                block[::4096] = b'\x01' * (len(block) // 4096)
                blocks.append(block)
                allocated += len(block)
            time.sleep(.125)
    except Exception as error:
        reason = type(error).__name__
    finally:
        blocks.clear()
        block = None
        signal.alarm(0)
    final = sample([target, original])
    print(json.dumps({'status': 'passed' if reason == 'target_protected' else 'failed',
        'reason': reason, 'targetPhoneId': target, 'originalPhoneId': original,
        'durationSeconds': round(time.monotonic() - started, 3),
        'allocationPeakBytes': allocated, 'allocationsReleased': True,
        'minimumAvailableBytes': min(v['available'] for v in readings),
        'maxPsiSome': max(v['psi'] for v in readings), 'maxPsiFull': max(v['psiFull'] for v in readings),
        'swapoutBytes': readings[-1]['swapout'] - readings[0]['swapout'],
        'initial': initial, 'trigger': readings[-1], 'afterRelease': final,
        'samplesTaken': len(readings), 'sampleIntervalSeconds': .125,
        'originalPhoneRecordPreserved': final['phones'][original] == initial['phones'][original],
        'floorBytes': FLOOR, 'targetAvailableBytes': TARGET, 'allocationCapBytes': MAX_BYTES,
        'maxSeconds': MAX_SECONDS, 'noStopCommandIssuedByFixture': True,
        'claimBoundary': 'Real host available-memory protection only; not an OOM or swap stress test.'}), flush=True)
    return 0 if reason == 'target_protected' else 1


if __name__ == '__main__':
    raise SystemExit(main(*sys.argv[1:]))
