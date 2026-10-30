"""New-install guest declarations; no guest is created or copied here."""
from pathlib import Path
import os
import re
import stat

from offline_common import need, within


def prepare_mountpoints(root, release):
    # /media is a read-only driver directory. Docker cannot create its nested
    # /media/installer target after mounting it, so prepare an empty target.
    asset = next(v for v in release['assets'] if v['role'] == 'computer-drivers')
    media = within(root / 'data', asset['destination'])
    target = media / 'installer'
    need(media.is_dir() and not media.is_symlink() and not target.is_symlink(), 'invalid driver mount path')
    target.mkdir(mode=0o755, exist_ok=True)
    need(target.is_dir() and not any(target.iterdir()), 'driver mount target must remain empty')


def cpu_groups(directory=Path('/sys/devices/system/cpu')):
    groups = {}
    for cpu in sorted(directory.glob('cpu[0-9]*')):
        if not re.fullmatch(r'cpu[0-9]+', cpu.name):
            continue
        if (cpu / 'online').exists() and (cpu / 'online').read_text().strip() == '0':
            continue
        # ARM MIDR identifies the core implementation, unlike logical CPU
        # numbering or guessed first/last CPU ranges on a development box.
        midr = cpu / 'regs/identification/midr_el1'
        need(midr.is_file(), 'CPU core type unavailable: ' + cpu.name)
        value = int(midr.read_text().strip(), 16)
        implementation = value & 0xff0ffff0
        groups.setdefault(implementation, []).append(int(cpu.name[3:]))
    need(groups, 'no online ARM CPU groups detected')
    return [sorted(v) for k, v in sorted(groups.items())]


def device_group(path):
    value = Path(path).stat()
    need(stat.S_ISCHR(value.st_mode) and value.st_gid > 0, 'guest device group is not configured: ' + str(path))
    return value.st_gid


def configurations(root, state, release, pool, groups=None, kvm_group=None, vhost_group=None):
    images = {v['role']: v['imageId'] for v in release['images']}
    assets = {v['role']: v for v in release['assets']}
    systems = release['guestSystems']
    need(systems['androidBaseBuildId'] == '16102939' and systems['androidVersion'] == '17',
         'Android build is not supported by the current ROM catalog schema')
    kinds = systems['cameraSources']
    need(kinds and len(set(kinds)) == len(kinds) and set(kinds) <= {'image', 'browser', 'video', 'usb', 'udp'},
         'camera capabilities must be declared by the release')
    groups = cpu_groups() if groups is None else groups
    kvm_group = device_group('/dev/kvm') if kvm_group is None else kvm_group
    vhost_group = device_group('/dev/vhost-vsock') if vhost_group is None else vhost_group
    need(kvm_group > 0 and vhost_group > 0 and groups and all(v for v in groups), 'invalid host guest resources')
    data, control, sockets = root / 'data', root / 'data/guests/control', root / 'guest-runtime'
    asset_path = lambda role: str(within(data, assets[role]['destination']))
    def asset_digest(role, filename):
        matches = [v for v in assets[role]['files'] if v['path'] == filename]
        need(len(matches) == 1, 'required guest asset missing: ' + role + '/' + filename)
        return 'sha256:' + matches[0]['sha256']
    versions = {key: key + '-' + images[role].split(':')[1] for key, role in
                [('standard', 'phone-runtime'), ('google-play', 'phone-google-runtime')]}
    roms = [dict(romVersionId=versions[key], imageDigest=images[role], cameraSources=kinds)
            for key, role in [('standard', 'phone-runtime'), ('google-play', 'phone-google-runtime')]]
    phone = dict(version=1, nodeId=state['nodeId'], nodeGeneration=1, poolId=pool,
                 imageId=images['phone-runtime'], additionalImageDigests=[images['phone-google-runtime']],
                 dataRoot=str(data / 'volumes'), controlRoot=str(control / 'phones'), storageSocket=str(sockets / 'storage.sock'),
                 kvmGroup=kvm_group, vhostGroup=vhost_group,
                 seccompFile=str(root / 'runtime/deploy/android/cuttlefish/phone-seccomp.json'),
                 networkProfile='isolated-egress-lan-v1', mediaAddress='',
                 hostMediaStateFile=str(root / 'public/phone-media-state.json'))
    # No persisted runtimeMaintenance/user/phone/volume identifiers are accepted.
    if {'usb', 'udp'} & set(kinds):
        phone['usbCameraSocket'] = str(sockets / 'camera.sock')
    profiles = []
    for family in ('windows', 'linux'):
        profiles.append(dict(SchemaVersion=2, OSFamily=family, Architecture='aarch64',
            ProfileID=family + '-arm64-user-iso', RuntimeImage=images['computer-runtime'],
            FirmwareDirectory=asset_path('computer-firmware'),
            FirmwareCodeDigest=asset_digest('computer-firmware', 'CODE.fd'),
            FirmwareVarsDigest=asset_digest('computer-firmware', 'VARS.fd'),
            MediaDirectory=asset_path('computer-drivers'), MediaDigest='', ManagedMedia=True,
            DriverDigest=asset_digest('computer-drivers', 'virtio.iso') if family == 'windows' else '',
            TPMRequired=family == 'windows', TPMPpi=family == 'windows', ShutdownSeconds=90))
    computer = dict(version=1, nodeId=state['nodeId'], minimumNodeGeneration=1, poolId=pool,
                    dataRoot=str(data / 'volumes'), storageSocket=str(sockets / 'storage.sock'),
                    resources=dict(ControlRoot=str(control / 'computers'), Profiles=profiles, CPUGroups=groups,
                                   KVMGroup=kvm_group, ProvisionMemoryBytes=512 * 1024**2))
    computer_api = dict(version=1, enabled=True,
        installedNodes=[dict(nodeId=state['nodeId'], poolId=pool, profileIds=[v['ProfileID'] for v in profiles],
            policy=dict(qemuOverheadBytes=512 * 1024**2, gatewayOverheadBytes=128 * 1024**2,
                storageReserveBytes=0,
                storageOverheadBytes=512 * 1024**2, maximumSampleAgeMs=30000))],
        policy=dict(mediaRuntimeImages=[images['computer-runtime']]),
        desktop=dict(guacamoleOrigin='http://127.0.0.1:18088/guacamole/', jsonSecretFile='/run/secrets/desktop_json_key'))
    catalog_computers = [dict(schemaVersion=2, id=p['ProfileID'],
        name='Windows' if p['OSFamily'] == 'windows' else 'Linux', version='ARM64', edition='User ISO',
        osFamily=p['OSFamily'], architecture='aarch64', runtimeImage=p['RuntimeImage'], mediaDigest=None,
        firmwareDigest=p['FirmwareCodeDigest'], driverDigest=p['DriverDigest'] or None,
        minimum=dict(vcpus=2, memoryGiB=4 if p['OSFamily'] == 'windows' else 2,
                     diskGiB=64 if p['OSFamily'] == 'windows' else 16),
        tpm=p['TPMRequired'], secureBoot=False, remoteDesktop=True,
        rights=dict(activationRequired=p['OSFamily'] == 'windows', redistributionAllowed=False,
                    remoteUseLicenseRequired=p['OSFamily'] == 'windows', environment='production')) for p in profiles]
    return dict(phones=phone, computers=computer, phoneSystems=versions, catalogComputers=catalog_computers,
        approvedPhones=[dict(nodeId=state['nodeId'], nodeGeneration=1, imageDigest=images['phone-runtime'],
                             poolId=pool, maximumPhones=None, roms=roms)], computerApi=computer_api,
        catalogRoms=[dict(id=v['romVersionId'], family_id='google-experimental' if i else 'aosp',
                         display_name='Android + Google Play' if i else '标准 Android',
                         version_label='Android ' + systems['androidVersion'], base_build_id=systems['androidBaseBuildId'],
                         runtime_image_digest=v['imageDigest'], google_play=bool(i), experimental=bool(i),
                         camera_capability='verified', create_enabled=True) for i, v in enumerate(roms)])
