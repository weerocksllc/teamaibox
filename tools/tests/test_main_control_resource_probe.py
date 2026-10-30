import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from main_control_resource_probe import summarize


def rows():
    return [dict(at=str(i), monotonic=i*5, cpuCount=4, cpuTicks=[100+i*100, 0, i*20, i*200, i*10, 0, 0, 0],
        memoryAvailableBytes=32*2**30, swapUsedBytes=0, gpu=dict(available=False),
        containers=[dict(id='one', image='image', startedAt='original', running=True, paused=i==1, oomKilled=False,
            cpu={'usage_usec': i*1_000_000}, io={'259:1': dict(rbytes=i*1000,wbytes=i*2000,rios=i,wios=i)},
            memoryBytes=2**30, swapBytes=0, memoryEvents=dict(oom=0,oom_kill=0))]) for i in range(3)]


class ResourceTest(unittest.TestCase):
    def test_core_rates_and_unsupported_codec(self):
        result=summarize(rows());self.assertEqual(result['rates'][0]['containers'][0]['cpuCores'], .2)
        self.assertEqual(result['rates'][0]['containers'][0]['io']['259:1']['wbytesPerSecond'],400)
        self.assertFalse(result['codecCountersAvailable']);self.assertFalse(result['hardwareCodecUsedProven'])
    def test_pause_does_not_imply_restart(self):
        self.assertEqual(summarize(rows())['seconds'],10)
    def test_new_io_device_and_old_oom_are_not_new_faults(self):
        value=rows()
        for r in value:r['containers'][0]['memoryEvents']['oom']=2
        for r in value[1:]:r['containers'][0]['io']['259:2']=dict(rbytes=100,wbytes=0,rios=1,wios=0)
        self.assertEqual(summarize(value)['seconds'],10)
    def test_na_codec_is_not_zero_utilization(self):
        value=rows()
        for r in value:r['gpu']=dict(available=True,rows=[['20','N/A','N/A','123','40']])
        self.assertFalse(summarize(value)['codecCountersAvailable'])
    def test_reject_corrupt_or_missing_samples(self):
        for mutate in (lambda x:x.pop(),lambda x:x[1].update(monotonic=30),
                       lambda x:x[1].update(swapUsedBytes=1),lambda x:x[1].update(memoryAvailableBytes=1),
                       lambda x:x[1]['containers'][0].update(startedAt='new'),
                       lambda x:x[1]['containers'][0]['cpu'].update(usage_usec=-1),
                       lambda x:x[1]['containers'][0]['memoryEvents'].update(oom_kill=1),
                       lambda x:x[1]['containers'][0]['io']['259:1'].update(wbytes=-1),
                       lambda x:x[1].update(containers=[])):
            value=copy.deepcopy(rows());mutate(value)
            with self.assertRaises(RuntimeError):summarize(value)


if __name__=='__main__':unittest.main()
