import copy
import unittest
from phone_camera_product_resource_guard import RUN_ID, validate_identity

class GuardIdentity(unittest.TestCase):
    def test_only_bounded_supported_run_names(self):
        for kind in ('product-hal','video-hal','lifecycle-google','lifecycle-standard'):
            self.assertIsNotNone(RUN_ID.fullmatch('phone-camera-'+kind+'-20260914-a3'))
        for name in ('phone-camera-lifecycle-google-20260914-a0','phone-camera-lifecycle-google-20260914-a3-extra',
                     'office-worker','phone-camera-lifecycle-other-20260914-a3','../phone-camera-product-hal-20260914-a1'):
            self.assertIsNone(RUN_ID.fullmatch(name))

    def test_new_run_names_do_not_relax_container_or_memory_identity(self):
        cid='a'*64;image='sha256:'+'b'*64;rid='phone-camera-lifecycle-google-20260914-a3'
        item={'Id':cid,'Image':image,'Name':'/'+rid,'Config':{'Labels':{'com.teamaibox.guest-network':rid}},
              'HostConfig':{'Memory':6*1024**3,'MemorySwap':6*1024**3}}
        validate_identity(item,cid,image,rid)
        for key in ('Id','Image','Name'):
            bad=copy.deepcopy(item);bad[key]='changed'
            with self.assertRaises(RuntimeError):validate_identity(bad,cid,image,rid)
        for key in ('Memory','MemorySwap'):
            bad=copy.deepcopy(item);bad['HostConfig'][key]=8*1024**3
            with self.assertRaises(RuntimeError):validate_identity(bad,cid,image,rid)

if __name__=='__main__':unittest.main()
