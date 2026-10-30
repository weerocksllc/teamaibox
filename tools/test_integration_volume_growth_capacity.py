import unittest
from luks2_disposable_integration_volume import validate_online_growth,IntegrationVolumeError
GIB=1024**3
class GrowthCapacityTests(unittest.TestCase):
 def test_growth_follows_available_disk_not_old_fixture_cap(self):
  for gib in (64,256,512,1024):
   self.assertEqual(validate_online_growth(gib*1024,16*GIB,2*1024*GIB),gib*GIB)
 def test_rejects_shrink_and_insufficient_real_backing_space(self):
  for size in (8*1024,1024*1024):
   with self.assertRaises(IntegrationVolumeError):validate_online_growth(size,16*GIB,100*GIB)
 def test_rejects_invalid_types_and_preserves_idempotent_size(self):
  for size in (True,16384.0,-1):
   with self.assertRaises(IntegrationVolumeError):validate_online_growth(size,16*GIB,100*GIB)
  self.assertEqual(validate_online_growth(16*1024,16*GIB,0),16*GIB)
if __name__=='__main__':unittest.main()
