import unittest
from appliance_resource_facts import calculate, QUANTUM

class BudgetTests(unittest.TestCase):
    def test_peaks_not_caps_plus_host_overhead_and_growth(self):
        sample=dict(core=[dict(peakBytes=10*2**30,currentBytes=1,maximumBytes=80*2**30)],
          outsideAnonBytes=2*2**30,outsideShmemBytes=2**30,kernelBytes=2**30,unevictableBytes=2**30)
        b=calculate([sample,sample]);self.assertEqual(b['measuredPeakBytes'],15*2**30)
        self.assertEqual(b['reserveBytes'],18*2**30)
    def test_round_up_and_peak_across_samples(self):
        s=dict(core=[dict(peakBytes=1)],outsideAnonBytes=0,outsideShmemBytes=0,kernelBytes=0,unevictableBytes=0)
        t={**s,'outsideAnonBytes':QUANTUM}
        self.assertEqual(calculate([s,t])['reserveBytes'],2*QUANTUM)
    def test_no_single_idle_sample(self):
        with self.assertRaises(Exception):calculate([])

if __name__=='__main__':unittest.main()
