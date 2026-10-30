import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from phone_gapps_pressure import GIB, RuntimePressure, without_owned_routes


def host(swap=0, psi=0, available=28 * GIB):
    return dict(swapout=swap, psi=psi, available=available)


class PressureTests(unittest.TestCase):
    def test_one_host_page_does_not_stop_phone(self):
        p = RuntimePressure()
        p.check(0, host(4357533696))
        p.check(6.8547, host(4357537792))
        p.check(20, host(4357537792))

    def test_sustained_swap_still_stops(self):
        p = RuntimePressure()
        p.check(0, host())
        p.check(6, host(12 * 1024 ** 2))
        with self.assertRaisesRegex(RuntimeError, 'swapout_sustained'):
            p.check(12, host(24 * 1024 ** 2))

    def test_swap_burst_resets(self):
        p = RuntimePressure()
        p.check(0, host())
        p.check(6, host(12 * 1024 ** 2))
        p.check(12, host(12 * 1024 ** 2))
        p.check(18, host(24 * 1024 ** 2))

    def test_psi_requires_ten_seconds(self):
        p = RuntimePressure()
        p.check(0, host(psi=5))
        p.check(6, host(psi=5))
        with self.assertRaisesRegex(RuntimeError, 'psi_sustained'):
            p.check(10, host(psi=5))

    def test_psi_recovery_resets(self):
        p = RuntimePressure()
        p.check(0, host(psi=5))
        p.check(6, host(psi=0))
        p.check(12, host(psi=5))
        p.check(18, host(psi=5))

    def test_low_available_immediate(self):
        with self.assertRaisesRegex(RuntimeError, 'available_below'):
            RuntimePressure().check(0, host(available=16 * GIB - 1))

    def test_bad_clock_and_counter_rejected(self):
        for at, swap in [(0, 20), (1, 9)]:
            p = RuntimePressure()
            p.check(0, host(10))
            with self.assertRaises(RuntimeError):
                p.check(at, host(swap))

    def test_only_owned_routes_excluded(self):
        owned = ['br-962b09ab0b13', 'veth293871a']
        routes = [{'dev': owned[0]}, {'dev': owned[1]}, {'dev': 'eth0'}, {'dev': 'br-111111111111'}]
        self.assertEqual(without_owned_routes(routes, owned), routes[2:])
        with self.assertRaises(RuntimeError):
            without_owned_routes(routes, ['eth0', owned[1]])


if __name__ == '__main__':
    unittest.main()
