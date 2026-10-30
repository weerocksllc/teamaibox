"""Runtime protection from the approved phone design, not a zero-swap test.

The Android cgroup remains swap-free. Host counters cover unrelated services,
so one host page-out is not evidence of sustained host pressure.
"""

GIB = 1024 ** 3
SWAP_RATE = 1024 ** 2


class RuntimePressure:
    def __init__(self):
        self.previous = None
        self.psi_since = None
        self.swap_since = None

    def check(self, at, host):
        if host['available'] < 16 * GIB:
            raise RuntimeError('host_available_below_16gib')
        if self.previous is not None and at <= self.previous[0]:
            raise RuntimeError('non_monotonic_pressure_sample')
        if host['psi'] >= 5:
            if self.psi_since is None:
                self.psi_since = at
        else:
            self.psi_since = None
        rate = 0
        if self.previous is not None:
            previous_at, previous_swapout = self.previous
            delta = host['swapout'] - previous_swapout
            if delta < 0:
                raise RuntimeError('host_swap_counter_reset')
            rate = delta / (at - previous_at)
            if rate > SWAP_RATE:
                if self.swap_since is None:
                    self.swap_since = previous_at
            else:
                self.swap_since = None
        self.previous = (at, host['swapout'])
        if self.psi_since is not None and at - self.psi_since >= 10:
            raise RuntimeError('host_psi_sustained_10s')
        if self.swap_since is not None and at - self.swap_since >= 10:
            raise RuntimeError('host_swapout_sustained_10s')
        return {'swapoutBytesPerSecond': rate,
                'psiDurationSeconds': 0 if self.psi_since is None else at - self.psi_since,
                'swapDurationSeconds': 0 if self.swap_since is None else at - self.swap_since}


def without_owned_routes(routes, owned_devices):
    """Exclude only the exact test bridge/veth, never a route-prefix wildcard."""
    import re
    if (len(owned_devices) != 2
            or not re.fullmatch(r'br-[0-9a-f]{12}', owned_devices[0])
            or not re.fullmatch(r'veth[0-9a-f]+', owned_devices[1])):
        raise RuntimeError('invalid_owned_route_devices')
    return [route for route in routes if route.get('dev') not in owned_devices]
