import unittest
from unittest.mock import patch

from factory_office_start import active_install_activity, host_memory, resident_memory
from offline_common import InstallError


class FirstStartMemoryTests(unittest.TestCase):
    def test_install_activity_uses_current_tables_and_only_live_scheduler_leases(self):
        with patch('factory_database.query', return_value='0') as query:
            self.assertEqual(active_install_activity('/install'), '0')
            root, sql = query.call_args.args
            self.assertEqual(root, '/install')
            for table in ('platform.phones', 'platform.computers', 'compute.lease_sets'):
                self.assertIn(table, sql)
            self.assertIn("state='active' AND expires_at>clock_timestamp()", sql)
            self.assertNotIn('cast_resource_reservations', sql)

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
