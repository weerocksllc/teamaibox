import copy
import unittest
import restore_existing_business_volumes as boot

VOLUMES = ({'root':'/srv/example-volume','mapper':'customer-volume',
            'luksUuid':'11111111-1111-4111-8111-111111111111',
            'fsUuid':'22222222-2222-4222-8222-222222222222',
            'minimumSize':4*1024**3,'mountOptions':'nodev,nosuid,noexec'},)


class GrowthBootTest(unittest.TestCase):
    def test_accepts_original_and_expanded_capacity(self):
        for volume in VOLUMES:
            for size in (volume['minimumSize'], 256 * 1024**3, 1024**4):
                boot.verify_image_size(volume, size)

    def test_rejects_truncation_and_misalignment(self):
        volume = VOLUMES[0]
        for size in (0, volume['minimumSize'] - 512, 256 * 1024**3 + 1, True):
            with self.assertRaisesRegex(RuntimeError, 'volume_size_invalid'):
                boot.verify_image_size(volume, size)

    def test_expansion_does_not_bypass_identity_or_mount_options(self):
        volume = VOLUMES[0]
        actual = dict(target=volume['root']+'/mount', source='/dev/mapper/'+volume['mapper'],
                      fstype='ext4', uuid=volume['fsUuid'], options='rw,nodev,nosuid,noexec')
        boot.verify_mount(volume, actual)
        for key, value in [('uuid', 'foreign'), ('source', '/dev/sda'), ('options', 'rw')]:
            changed = copy.deepcopy(actual)
            changed[key] = value
            with self.assertRaises(RuntimeError):
                boot.verify_mount(volume, changed)


if __name__ == '__main__':
    unittest.main()
