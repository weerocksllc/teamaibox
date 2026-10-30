import unittest

from factory_office_start import host_memory, resident_memory
from offline_common import InstallError


class FirstStartMemoryTests(unittest.TestCase):
    def test_resident_working_set_excludes_only_measured_inactive_file_cache(self):
        memory = dict(current=6554730496, inactiveFile=1930158080, shmem=134217728)
        self.assertEqual(resident_memory(memory), 4624572416)
        # Admission keeps the complete charged memory, including file cache.
        self.assertEqual(memory['current'], 6554730496)
        self.assertEqual(resident_memory(dict(current=6554730496)), 6554730496)

    def test_invalid_cache_cannot_create_free_capacity(self):
        for inactive in (-1, 100, 101, 1.5, True):
            with self.subTest(inactive=inactive), self.assertRaises(InstallError):
                resident_memory(dict(current=100, inactiveFile=inactive))

    def test_retained_swap_is_not_current_pressure(self):
        value = host_memory('MemTotal: 128000000 kB\nMemAvailable: 118000000 kB\n'
                            'SwapTotal: 16000000 kB\nSwapFree: 15996000 kB\n')
        self.assertEqual(value, dict(MemTotal=128000000 * 1024, MemAvailable=118000000 * 1024))

    def test_low_available_memory_is_not_inflated(self):
        self.assertEqual(host_memory('MemTotal: 128000000 kB\nMemAvailable: 100 kB\n')['MemAvailable'], 102400)

    def test_missing_or_impossible_observation_fails(self):
        for value in ('MemTotal: 100 kB\n', 'MemTotal: 100 kB\nMemAvailable: 101 kB\n',
                      'MemTotal: 100 kB\nMemAvailable: 0 kB\n'):
            with self.subTest(value=value), self.assertRaises(InstallError):
                host_memory(value)


if __name__ == '__main__':
    unittest.main()
