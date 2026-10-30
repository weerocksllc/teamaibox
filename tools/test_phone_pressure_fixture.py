import unittest
from phone_pressure_fixture import allocation_step,pressure_action,FLOOR,TARGET,MAX_BYTES,MAX_SECONDS,MAX_SWAPOUT


class PressureFixtureTests(unittest.TestCase):
    def test_safety_floor_stops_instead_of_chasing_oom(self):
        self.assertEqual(allocation_step(FLOOR-1,0,1,False),'safety-floor')

    def test_target_holds_without_more_allocation(self):
        self.assertEqual(allocation_step(TARGET,1024,1,False),'hold')

    def test_guard_immediately_releases_fixture(self):
        self.assertEqual(allocation_step(TARGET,1024,1,True),'protected')

    def test_absolute_limits(self):
        self.assertEqual(allocation_step(TARGET+1,MAX_BYTES,1,False),'allocation-cap')
        self.assertEqual(allocation_step(TARGET+1,0,MAX_SECONDS,False),'deadline')

    def test_only_safe_headroom_allows_a_small_step(self):
        self.assertEqual(allocation_step(TARGET+1,0,1,False),'allocate')

    def test_small_non_sustained_pageout_is_not_a_phone_failure(self):
        samples=[dict(seconds=0,swapout=0,psi=0,psiFull=0),
                 dict(seconds=6.5,swapout=4624384,psi=0,psiFull=0)]
        self.assertEqual(pressure_action(samples),'allocate')

    def test_product_pressure_holds_further_allocation(self):
        for swapout,psi in [(4*1024**2,0),(0,5)]:
            samples=[dict(seconds=0,swapout=0,psi=0,psiFull=0),
                     dict(seconds=2,swapout=swapout,psi=psi,psiFull=0)]
            self.assertEqual(pressure_action(samples),'hold')

    def test_emergency_limits_remain_absolute(self):
        for key,value in [('swapout',MAX_SWAPOUT+1),('psi',10),('psiFull',2)]:
            samples=[dict(seconds=0,swapout=0,psi=0,psiFull=0),
                     dict(seconds=2,swapout=0,psi=0,psiFull=0)]
            samples[-1][key]=value
            self.assertEqual(pressure_action(samples),'safety-pressure')


if __name__=='__main__':unittest.main()
