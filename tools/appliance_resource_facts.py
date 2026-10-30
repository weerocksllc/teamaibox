"""Pure resource-budget and persistent-guest identity checks for this appliance."""
import copy

QUANTUM = 256 * 2**20

def calculate(samples):
    if len(samples) < 2:
        raise RuntimeError('insufficient_samples')
    peak = max(sum(c['peakBytes'] for c in s['core']) + s['outsideAnonBytes']
               + s['outsideShmemBytes'] + s['kernelBytes'] + s['unevictableBytes']
               for s in samples)
    budget = ((peak * 120 + 100 * QUANTUM - 1) // (100 * QUANTUM)) * QUANTUM
    return dict(measuredPeakBytes=peak, reserveBytes=budget, growthPermille=1200)

def normalize_guest_facts(facts):
    result = copy.deepcopy(facts)
    for container in result['containers']:
        mounts = container['mounts']
        destinations = [mount['Destination'] for mount in mounts]
        if len(destinations) != len(set(destinations)):
            raise RuntimeError('duplicate_mount_destination')
        container['mounts'] = sorted(mounts, key=lambda mount: mount['Destination'])
    return result
