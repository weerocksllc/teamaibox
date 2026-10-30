import unittest
from phone_camera_guest_driver_patch import adapt

class GuestMmapPatch(unittest.TestCase):
    def test_only_mmap_offsets_change_not_guest_pointers(self):
        raw='prefix\n\tdqbuf->buffer.m = buffer_m;\n\t\t\tdqbuf->planes[i].m = plane_m;\nsuffix\n'
        result=adapt(raw)
        self.assertIn('V4L2_TYPE_IS_MULTIPLANAR(dqbuf->buffer.type) ||',result)
        self.assertEqual(result.count('dqbuf->buffer.memory != V4L2_MEMORY_MMAP'),2)
        self.assertIn('\t\tdqbuf->buffer.m = buffer_m;',result)
        self.assertIn('\t\t\t\tdqbuf->planes[i].m = plane_m;',result)
        self.assertTrue(result.startswith('prefix\n') and result.endswith('suffix\n'))

    def test_unknown_or_repeated_patch_is_rejected(self):
        with self.assertRaises(ValueError):adapt('unrelated kernel source')
        raw='\tdqbuf->buffer.m = buffer_m;\n\t\t\tdqbuf->planes[i].m = plane_m;'
        with self.assertRaises(ValueError):adapt(raw+raw)
        with self.assertRaises(ValueError):adapt(adapt(raw))

if __name__=='__main__':unittest.main()
