"""Narrow QMP optical-drive adapter. No guest restart or forced eject.

Paths come only from an admitted digest in this computer's read-only media
directory. The caller owns durable operation/revision reconciliation. This
module never accepts a QMP command or device ID from a member request.
"""
import hashlib
from pathlib import Path
import re

DIGEST = re.compile(r'sha256:[a-f0-9]{64}')


class OpticalDrive:
    def __init__(self, qmp, directory=Path('/media/installer')):
        self.qmp = qmp
        self.directory = Path(directory)
        self.device_id = None

    def _path(self, digest):
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise ValueError('computer_media_invalid')
        return self.directory / (digest[7:] + '.iso')

    def inspect(self):
        blocks = self.qmp.send('query-block')
        if not isinstance(blocks, list):
            raise RuntimeError('computer_media_state_unknown')
        entries = [block for block in blocks if isinstance(block, dict) and block.get('device') == 'installer']
        if len(entries) != 1 or entries[0].get('removable') is not True:
            raise RuntimeError('computer_media_runtime_unsupported')
        block = entries[0]
        # usb-storage owns a child SCSI CD device. Its outer QOM ID is not a
        # BlockBackend and QMP rejects media changes against that outer ID.
        # Resolve only the exact child produced by our fixed device recipe.
        device_id = block.get('qdev')
        if device_id != '/machine/peripheral/installer-device/installer-device.0/legacy[0]':
            raise RuntimeError('computer_media_runtime_unsupported')
        self.device_id = device_id
        inserted = block.get('inserted')
        digest = None
        if inserted:
            name = inserted.get('file')
            if not isinstance(name, str):
                raise RuntimeError('computer_media_state_unknown')
            match = re.fullmatch(r'([a-f0-9]{64})\.iso', Path(name).name)
            if not match or Path(name) != self._path('sha256:' + match[1]):
                # Do not publish the unexpected private path in an error.
                raise RuntimeError('computer_media_state_unknown')
            digest = 'sha256:' + match[1]
        return {'digest': digest, 'locked': block.get('locked') is True,
                'trayOpen': block.get('tray_open') is True}

    def change(self, digest):
        # Query before executing: replay after a lost response is a no-op when
        # the requested medium is already visible. An uncertain read is not
        # permission to issue another destructive command.
        if digest is not None:
            path = self._path(digest)
        state = self.inspect()
        if state['digest'] == digest and (digest is None or not state['trayOpen']):
            return state
        if state['locked']:
            raise RuntimeError('computer_media_locked')
        if digest is not None:
            if self.directory.is_symlink() or path.is_symlink() or not path.is_file():
                raise RuntimeError('computer_media_unavailable')
            actual = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    actual.update(chunk)
            if 'sha256:' + actual.hexdigest() != digest:
                raise RuntimeError('computer_media_digest_mismatch')
            command, arguments = 'blockdev-change-medium', {
                'id': self.device_id, 'filename': str(path), 'format': 'raw',
                'read-only-mode': 'read-only', 'force': False}
        else:
            command, arguments = 'eject', {'id': self.device_id, 'force': False}
        error = None
        try:
            self.qmp.send(command, arguments)
        except RuntimeError as caught:
            error = caught
        observed = self.inspect()
        if observed['digest'] == digest and (digest is None or not observed['trayOpen']):
            return observed
        # After a mutation was attempted, a locked tray does not prove that
        # nothing changed. Preserve both references until QMP is reconciled.
        if observed['locked']:
            raise RuntimeError('computer_media_change_unconfirmed')
        if error:
            raise RuntimeError('computer_media_change_unconfirmed') from error
        raise RuntimeError('computer_media_change_unconfirmed')
