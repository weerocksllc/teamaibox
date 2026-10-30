"""Install missing root tools from an isolated file-only apt repository.

The dependency inventory is availability, not an instruction to upgrade all
libraries. Host apt sources, Docker, NVIDIA and kernel are never replaced.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import quote

from offline_common import atomic, digest, need, run


FORBIDDEN = ('docker', 'containerd', 'nvidia', 'libnvidia', 'cuda', 'linux-image', 'linux-headers')
ROOT_PACKAGES = ('cryptsetup-bin', 'e2fsprogs', 'util-linux', 'iproute2', 'openssl',
                 'usbutils', 'v4l-utils', 'qemu-utils', 'iptables', 'kmod')


def installed(name):
    result = subprocess.run(['dpkg-query', '-W', '-f=${db:Status-Status}', name], capture_output=True, text=True)
    return result.returncode == 0 and result.stdout == 'installed'


def validate_transaction(output, available):
    for line in output.splitlines():
        if line.startswith(('Inst ', 'Remv ')):
            name = line.split()[1].split(':')[0]
            need(not line.startswith('Remv '), 'offline tool install would remove an existing package: ' + name)
            need(name in available and not name.startswith(FORBIDDEN), 'offline tool install would alter undeclared/foundation package: ' + name)


def install(packages, required=ROOT_PACKAGES, runner=run, installed_query=installed):
    need(required and all(re.fullmatch(r'[a-z][a-z0-9+.-]*', n) and not n.startswith(FORBIDDEN) for n in required),
         'invalid required host tools')
    missing = [name for name in required if not installed_query(name)]
    if not missing:
        return {'installed': [], 'existingToolsPreserved': True}
    with tempfile.TemporaryDirectory(prefix='teamaibox-offline-apt-', dir='/var/tmp') as temporary:
        root = Path(temporary)
        repo, cache, lists = root / 'repo', root / 'cache/archives', root / 'lists'
        for directory in (repo, cache / 'partial', lists / 'partial'):
            directory.mkdir(parents=True)
        records, available = [], set()
        for row in packages:
            path = Path(row['source']).resolve(strict=True)
            need(path.suffix == '.deb' and digest(path) == row['sha256'], 'offline host package damaged')
            control = runner(['dpkg-deb', '-f', path])
            fields = dict(line.split(': ', 1) for line in control.splitlines() if ': ' in line and not line.startswith(' '))
            name, version, arch = (fields[k] for k in ('Package', 'Version', 'Architecture'))
            need(re.fullmatch(r'[a-z][a-z0-9+.-]*', name) and not name.startswith(FORBIDDEN)
                 and arch in ('arm64', 'all'), 'invalid host dependency')
            need(name not in available, 'multiple versions of host dependency: ' + name)
            available.add(name)
            # libapt uses lowercase percent escapes for the Debian epoch colon.
            filename = name + '_' + quote(version, safe='+.~-').replace('%3A', '%3a') + '_' + arch + '.deb'
            (repo / filename).symlink_to(path)
            # apt deliberately does not treat a symlink as a downloaded archive.
            shutil.copyfile(path, cache / filename)
            records.append(control.rstrip() + '\nFilename: ' + str(path) + '\nSize: ' + str(path.stat().st_size)
                           + '\nSHA256: ' + row['sha256'] + '\n')
        need(set(required).issubset(available), 'host tool dependency inventory incomplete')
        atomic(repo / 'Packages', ('\n'.join(records) + '\n').encode(), 0o644)
        atomic(root / 'sources.list', ('deb [trusted=yes] file:' + str(repo) + ' ./\n').encode(), 0o644)
        options = ['-o', 'Dir::Etc::main=/dev/null', '-o', 'Dir::Etc::parts=-',
                   '-o', 'Dir::Etc::sourcelist=' + str(root / 'sources.list'), '-o', 'Dir::Etc::sourceparts=-',
                   '-o', 'Dir::State::lists=' + str(lists), '-o', 'Dir::Cache=' + str(root / 'cache'),
                   '-o', 'Dir::Cache::archives=' + str(cache), '-o', 'APT::Sandbox::User=root',
                   '-o', 'Acquire::Languages=none', '-o', 'Acquire::Retries=0',
                   '-o', 'APT::Install-Recommends=false', '-o', 'APT::Install-Suggests=false']
        # Index ONLY this local file source; no host sources or mirror access.
        runner(['apt-get', *options, 'update'], timeout=120)
        flags = ['--no-download', '--no-remove', '-y', *options]
        simulated = runner(['apt-get', '--simulate', *flags, 'install', *missing], timeout=180)
        validate_transaction(simulated, available)
        env = dict(os.environ, DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='l')
        runner(['apt-get', *flags, 'install', *missing], timeout=900, env=env)
        need(all(installed_query(name) for name in required), 'required host tool installation incomplete')
        return {'installed': missing, 'existingToolsPreserved': True}
