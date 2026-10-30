"""New-appliance identity and inventory from this host, never a donor machine."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import ssl

from offline_common import need, run


def fingerprint(value):
    return 'sha256:' + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


CASTING_ELEMENTS = ('avdec_h264', 'gdppay', 'gdpdepay', 'fdsink', 'fdsrc',
                    'appsink', 'appsrc', 'livekitwebrtcsink', 'vp8enc', 'opusenc')


def casting_capacity(image, runner=run):
    """Advertise the packaged CPU pipeline, not fictional GB10 hardware codecs."""
    need(re.fullmatch(r'sha256:[a-f0-9]{64}', image or ''), 'casting image identity missing')
    script = ('import gi,json;gi.require_version("Gst","1.0");from gi.repository import Gst;'
              'Gst.init(None);print(json.dumps({n:bool(Gst.ElementFactory.find(n)) for n in '
              + repr(CASTING_ELEMENTS) + '}))')
    observed = json.loads(runner(['docker', 'run', '--rm', '--network', 'none', '--pull', 'never',
                                 '--entrypoint', 'python3', image, '-c', script]))
    need(set(observed) == set(CASTING_ELEMENTS) and all(v is True for v in observed.values()),
         'packaged casting software pipeline is incomplete')
    return dict(encodeSessions=1, decodeSessions=1, evidenceDigest=fingerprint(
        dict(imageId=image, pipeline='software-h264-vp8-opus', elements=observed)))


def certificate_identity(certificate, node_id, runner=run):
    pem = Path(certificate).read_text()
    der = ssl.PEM_cert_to_DER_cert(pem)
    end = runner(['openssl', 'x509', '-in', certificate, '-noout', '-enddate']).strip()
    need(end.startswith('notAfter='), 'node certificate validity missing')
    expiry = datetime.datetime.strptime(end[9:], '%b %d %H:%M:%S %Y GMT').replace(tzinfo=datetime.timezone.utc)
    need(expiry > datetime.datetime.now(datetime.timezone.utc), 'node certificate expired')
    return dict(nodeId=node_id, nodeKey='localhost', generation=1,
                certificateFingerprint='sha256:' + hashlib.sha256(der).hexdigest(),
                certificateNotAfter=expiry.isoformat().replace('+00:00', 'Z'))


def inventory(data, *, agent_version, proc=Path('/proc'), sys_net=Path('/sys/class/net'),
              cpu_count=None, runner=run, stats=None, casting_image=None):
    need(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?', agent_version), 'Agent release version missing')
    memory = {line.split(':', 1)[0]: int(line.split()[1]) * 1024
              for line in (proc / 'meminfo').read_text().splitlines() if line.startswith(('MemTotal:', 'MemAvailable:'))}
    cores = cpu_count if cpu_count is not None else len(os.sched_getaffinity(0))
    need(cores > 0 and memory['MemTotal'] >= memory['MemAvailable'] > 0, 'host capacity unavailable')
    gpu = runner(['nvidia-smi', '--query-gpu=name,compute_cap', '--format=csv,noheader']).strip().splitlines()
    need(len(gpu) == 1, 'this installer expects one DGX Spark GPU')
    name, capability = (part.strip() for part in gpu[0].split(',', 1))
    need('GB10' in name and re.fullmatch(r'[0-9]+\.[0-9]+', capability), 'DGX Spark GPU capability unavailable')
    links = []
    for device in sorted(sys_net.iterdir()):
        if not (device / 'device').exists():
            continue
        try:
            speed = max(0, int((device / 'speed').read_text())) * 1_000_000
            mtu = int((device / 'mtu').read_text())
            up = (device / 'operstate').read_text().strip() == 'up'
        except (OSError, ValueError):
            # Wi-Fi may not expose a negotiated link speed in sysfs. Do not
            # advertise a made-up network capacity or suppress other devices.
            continue
        # Spark's predictable names include an uppercase PCI-domain P
        # (for example enP7s7). Read sysfs with its exact name; normalize only
        # the product's logical link key, whose contract is lowercase.
        link_key = device.name.lower()
        if not re.fullmatch(r'[a-z][a-z0-9_.-]{2,127}', link_key) or not 1280 <= mtu <= 65535:
            continue
        need(not any(link['linkKey'] == link_key for link in links), 'ambiguous physical network link key')
        links.append(dict(linkKey=link_key, networkClass='management', health='healthy' if up else 'down',
                          speedBitsPerSecond=speed if up else 0, mtu=mtu, latencyMicroseconds=0))
    filesystem = stats if stats is not None else os.statvfs(data)
    available = filesystem.f_bavail * filesystem.f_frsize
    gpu_facts = dict(name=name, computeCapability=capability)
    storage_facts = dict(availableBytes=available, filesystemId=filesystem.f_fsid)
    codec = casting_capacity(casting_image, runner) if casting_image else dict(
        encodeSessions=0, decodeSessions=0, evidenceDigest=fingerprint({'hardwareSessionsAdvertised': False}))
    return dict(schemaVersion=1, architecture='arm64', agentVersion=agent_version,
        health=dict(state='healthy', errorCode=None), runtimes=[], modelProfiles=[], capabilities=[],
        resources=dict(cpu=dict(totalMillis=cores * 1000, availableMillis=cores * 1000),
            unifiedMemory=dict(totalBytes=memory['MemTotal'], availableBytes=memory['MemAvailable']),
            accelerator=dict(units=1), codecs=dict(sessions=codec['encodeSessions'] + codec['decodeSessions']), storage=dict(availableBytes=available),
            network=dict(availableBitsPerSecond=sum(link['speedBitsPerSecond'] for link in links))),
        schedulerFacts=dict(
            accelerator=dict(kind='nvidia-gb10', computeCapability=capability,
                supportedPrecisions=['fp32', 'bf16', 'fp16', 'fp8', 'nvfp4', 'int8', 'int4'], evidenceDigest=fingerprint(gpu_facts)),
            codec=codec,
            storage=dict(classes=['local-block'], evidenceDigest=fingerprint(storage_facts)),
            workerState='cold', modelArtifactCached=False, inputArtifactIds=[]),
        networkLinks=links, reservations={key: 0 for key in
            ('cpuMillis', 'unifiedMemoryBytes', 'acceleratorUnits', 'codecSessions', 'storageBytes', 'networkBitsPerSecond')},
        activeWorkloads=0)
