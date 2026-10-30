import json
import unittest
import restore_calibrated_office_workers_v2 as v2
from test_calibrated_office_boot import fixture


class PressureTests(unittest.TestCase):
    def run_samples(self,samples,check=False,timeout=60):
        value,_,_,_=fixture();ticks=[0];calls=[];remaining=iter(samples);last=[None]
        def sample(_):
            calls.append(ticks[0]);last[0]=next(remaining,last[0]);return last[0]
        def sleep(seconds):ticks[0]+=seconds
        result=v2.settled_snapshot(value,sample,lambda:ticks[0],sleep,check,timeout)
        return result,ticks[0],calls

    def test_transient_pressure_waits_without_lowering_ready_threshold(self):
        _,_,_,s=fixture()
        (result,observations),elapsed,calls=self.run_samples([{**s,'fullAverage10':.3},{**s,'fullAverage10':.1},s])
        self.assertEqual(elapsed,6);self.assertEqual(result,s);self.assertEqual(calls,[0,3,6]);self.assertEqual(len(observations),3)

    def test_sustained_pressure_is_bounded_and_records_rejection(self):
        _,_,_,s=fixture()
        with self.assertRaises(RuntimeError) as error:self.run_samples([{**s,'fullAverage10':.2}],timeout=5)
        result=json.loads(str(error.exception));self.assertEqual(result['pressureWaitSeconds'],5)
        self.assertEqual(result['rejectedSnapshot']['fullAverage10'],.2)

    def test_warm_check_rejects_instead_of_waiting(self):
        _,_,_,s=fixture()
        with self.assertRaises(RuntimeError) as error:self.run_samples([{**s,'fullAverage10':.2},s],check=True)
        self.assertEqual(json.loads(str(error.exception))['pressureWaitSeconds'],0)

    def test_real_oom_fails_but_large_legacy_reservations_do_not(self):
        value,_,_,s=fixture()
        with self.assertRaisesRegex(RuntimeError,'boot_memory_pressure'):
            self.run_samples([{**s,'oomKilled':True}])
        result,_,_=self.run_samples([{**s,'corePeakBytes':2**50,'unrealizedOtherBytes':2**50,'availableBytes':1}])
        self.assertEqual(result[0]['availableBytes'],1)

    def test_invalid_pressure_cannot_be_treated_as_settled(self):
        _,_,_,s=fixture()
        for pressure in (None,float('nan'),float('inf'),-.1,True,'0'):
            with self.assertRaisesRegex(RuntimeError,'invalid_boot_memory_evidence'):self.run_samples([{**s,'fullAverage10':pressure}])


if __name__=='__main__':unittest.main()
