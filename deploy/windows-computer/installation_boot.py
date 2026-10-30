"""First-boot ordering using only bootindex, never -boot once/order.

QEMU builds the current fw_cfg bootorder during machine reset. Start paused
with the installer at index 0, then restore its device index to 2 BEFORE any
guest CPU runs. This leaves the first fw_cfg list intact and makes the next
reset regenerate disk-first order. Media stays mounted. A durable armed record
precedes releasing CPUs; loss of the consumed acknowledgement cannot re-arm
an old boot request. This helper never issues a reset or opens a guest disk.
"""
import json
from pathlib import Path
import re

UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')


def prepare_disc_boot(qmp):
    state = qmp.send('query-status')
    if not isinstance(state, dict) or state.get('running') is not False or state.get('status') not in ('prelaunch', 'paused'):
        raise RuntimeError('computer_installation_boot_not_paused')
    target = {'path': '/machine/peripheral/installer-device', 'property': 'bootindex'}
    value = qmp.send('qom-get', target)
    if value == 2:
        return  # Lost qom-set acknowledgement; do not reset or re-arm.
    if value != 0:
        raise RuntimeError('computer_installation_boot_mismatch')
    try:
        qmp.send('qom-set', {**target, 'value': 2})
    except RuntimeError:
        if qmp.send('qom-get', target) != 2:
            raise RuntimeError('computer_installation_boot_unconfirmed')
    if qmp.send('qom-get', target) != 2:
        raise RuntimeError('computer_installation_boot_unconfirmed')


class InstallationLaunch:
    """Immutable per-run request, separate from permanent disk configuration.

    The Agent supplies request.json in the read-only configuration directory.
    A durable armed record precedes cont; consumed means QMP confirmed CPUs
    running. A process restart with armed/uncertain evidence must not re-arm.
    """
    def __init__(self, config, config_directory, control, write_json):
        self.config = dict(config)
        self.managed_media = config['schemaVersion'] == 2
        self.disc_boot = False
        self.record = None
        self.confirmation_pending = False
        self.path = Path(control)/'installation-boot.json'
        self.write_json = write_json
        path = Path(config_directory)/'installation-request.json'
        if not path.exists() and not path.is_symlink():
            return
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 4096:
            raise ValueError('computer_installation_request_invalid')
        request = json.loads(path.read_text())
        identity = ('computerId', 'ownerId', 'volumeId', 'runId', 'generation')
        if not isinstance(request, dict) or set(request) != {*identity, 'revision', 'digest', 'bootRequestId'} or any(request[k] != config[k] for k in identity):
            raise ValueError('computer_installation_request_invalid')
        if type(request['generation']) is not int or type(request['revision']) is not int or not 0 < request['revision'] < 2**53:
            raise ValueError('computer_installation_request_invalid')
        digest, boot_id = request['digest'], request['bootRequestId']
        if digest is not None and (not isinstance(digest, str) or not DIGEST.fullmatch(digest)):
            raise ValueError('computer_installation_request_invalid')
        if boot_id is not None and (not isinstance(boot_id, str) or not UUID.fullmatch(boot_id) or digest is None):
            raise ValueError('computer_installation_request_invalid')
        self.config['mediaDigest'] = digest
        self.managed_media = True
        if boot_id is None:
            return
        self.record = {**{k: config[k] for k in identity}, 'requestId': boot_id, 'revision': request['revision']}
        if self.path.exists() or self.path.is_symlink():
            if self.path.is_symlink() or not self.path.is_file() or self.path.stat().st_size > 4096:
                raise RuntimeError('computer_installation_boot_unconfirmed')
            observed = json.loads(self.path.read_text())
            if not isinstance(observed, dict) or set(observed) != {*self.record, 'state'} or any(observed[k] != v for k, v in self.record.items()):
                raise RuntimeError('computer_installation_boot_unconfirmed')
            if observed['state'] == 'consumed':
                return
            raise RuntimeError('computer_installation_boot_unconfirmed')
        self.disc_boot = True

    def release(self, qmp):
        if not self.disc_boot:
            return
        prepare_disc_boot(qmp)
        self.write_json(self.path, {**self.record, 'state': 'armed'})
        try:
            qmp.send('cont')
        except RuntimeError:
            pass  # Query the same process; a lost reply is not another boot.
        # Once cont was attempted, a transport or journal failure must NOT
        # unwind serve() and kill a possibly running installer. Keep the armed
        # record and guest alive; inspection can reconcile this same process.
        self.confirmation_pending = True
        self.disc_boot = False
        self.reconcile(qmp)

    def reconcile(self, qmp):
        if not self.confirmation_pending:
            return
        try:
            observed = qmp.send('query-status')
            if isinstance(observed, dict) and observed.get('running') is True:
                self.write_json(self.path, {**self.record, 'state': 'consumed'})
                self.confirmation_pending = False
        except (RuntimeError, OSError):
            pass
