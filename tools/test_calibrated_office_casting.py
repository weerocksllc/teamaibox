import inspect
import unittest
import restore_calibrated_office_workers as base
import restore_calibrated_office_workers_v3 as v3
from test_calibrated_office_boot import fixture, FakeAdapter

class CastingBootTests(unittest.TestCase):
    def test_no_resource_ledger_is_queried_during_boot(self):
        self.assertFalse(hasattr(v3,'reservation_query'))
        self.assertNotIn('resource_reservations',inspect.getsource(v3.CastingAdapter))

    def test_guest_growth_estimates_cannot_block_existing_healthy_models(self):
        value,b,_,s=fixture()
        s.update(availableBytes=1,otherBytes=2**50,unrealizedOtherBytes=2**50,corePeakBytes=2**50)
        adapter=FakeAdapter(b['containers'],s,running=[e['id'] for e in b['containers']])
        result=base.restore(value,b['containers'],adapter,True)
        self.assertEqual(result['startedIds'],[])
        self.assertEqual(adapter.calls,[])

    def test_actual_pressure_and_oom_are_still_reported(self):
        value,_,_,s=fixture()
        for patch in [dict(oomKilled=True),dict(fullAverage10=.1)]:
            with self.assertRaisesRegex(RuntimeError,'boot_memory_pressure'):
                base.observe(value,{**s,**patch},set())

if __name__=='__main__':unittest.main()
