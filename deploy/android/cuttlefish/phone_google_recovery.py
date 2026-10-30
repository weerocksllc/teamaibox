"""Refresh pre-registration Google verdicts without touching accounts or identity.

Google's clients obtain and verify the replacement verdict themselves. This is
not device certification and does not register a device, grant Google access,
or make a newly rejected device eligible. Unknown cache formats are left alone.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import threading

from phone_google_compliance import PATHS, summarize_cache

GSERVICES = ('/data/user/0/com.google.android.gms/databases/gservices.db',
             '/data/user/0/com.google.android.gsf/databases/gservices.db')


class GoogleCacheRecovery:
    def __init__(self, runtime, directory):
        self.runtime = runtime
        self.file = Path(directory) / '.google-registration-recovery.json'
        self.state = {}
        try:
            self.state = json.loads(self.file.read_text())
        except (OSError, ValueError):
            pass

    def save(self):
        temporary = self.file.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(self.state, stream, sort_keys=True)
        os.replace(temporary, self.file)

    def shell(self, command):
        if self.runtime.stopping.is_set():
            raise RuntimeError('phone_stopping')
        result = self.runtime.adb('shell', 'su', '0', 'sh', '-c', shlex.quote(command), timeout=8)
        if result.returncode:
            raise RuntimeError('google_recovery_command_failed')
        return result.stdout.strip()

    def snapshot(self):
        # Only these two keys; never enumerate account, check-in or auth tables.
        values = {}
        for database in GSERVICES:
            rows = self.shell('if test -f ' + database + '; then sqlite3 -readonly ' + database + ' ' + shlex.quote(
                "select name,value from main where name in ('android_id','uncertified_status');") + '; fi')
            values = dict(line.split('|', 1) for line in rows.splitlines() if '|' in line)
            if values.get('android_id'):
                break
        identity = values.get('android_id', '')
        if not re.fullmatch(r'[0-9]{1,20}', identity):
            raise ValueError('google_identity_not_ready')
        snapshot = {'gsfIdSha256': hashlib.sha256(identity.encode()).hexdigest(),
                    'legacyStatus': values.get('uncertified_status'), 'caches': {}}
        for kind, path in PATHS.items():
            # Binary bytes never pass through text decoding and are not persisted.
            encoded = self.shell('if test -f ' + path + '; then base64 ' + path + '; fi')
            if encoded:
                snapshot['caches'][kind] = summarize_cache(base64.b64decode(encoded), kind)
        return snapshot

    def refresh(self, caches):
        # Do not bring the Store to the front over a different user application.
        foreground = self.shell('dumpsys activity activities | ' +
                                "sed -n '/mResumedActivity:\\|topResumedActivity=/p'")
        reopen = 'com.android.vending/' in foreground
        self.shell('am force-stop com.android.vending; am force-stop com.google.android.gms')
        checks, moves = [], []
        for kind, value in caches.items():
            path = PATHS[kind]
            digest = value['sha256']
            if not re.fullmatch('[0-9a-f]{64}', digest):
                raise ValueError('invalid_cache_digest')
            backup = path + '.before-registration-refresh-' + digest[:16]
            checks += ['test "$(sha256sum ' + path + ' | cut -d\" \" -f1)" = ' + digest,
                       'test ! -e ' + backup]
            moves.append('mv ' + path + ' ' + backup)
        try:
            # Recheck every exact file before moving either, and retain originals.
            self.shell(' && '.join(checks + moves))
        finally:
            if reopen and not self.runtime.stopping.is_set():
                self.shell('am start -a android.intent.action.MAIN ' +
                           '-c android.intent.category.LAUNCHER -p com.android.vending')

    def tick(self):
        observation = self.snapshot()
        identity = observation['gsfIdSha256']
        if self.state.get('gsfIdSha256') != identity:
            self.state = {'gsfIdSha256': identity, 'attempted': False}
        legacy = observation['legacyStatus']
        if legacy == '3':
            # Re-arm only on a real not-registered -> registered transition, not
            # because Google issued another denial or the guest was restarted.
            self.state.update(state='registration_required', wasUnregistered=True)
            self.save()
            return
        if legacy != '1':
            self.state['state'] = 'waiting_for_google'
            self.save()
            return
        if self.state.pop('wasUnregistered', False):
            self.state['attempted'] = False
        caches = observation['caches']
        if len(caches) != 2:
            self.state['state'] = 'waiting_for_verdict'
        elif any(c['gsfIdSha256'] != identity for c in caches.values()):
            self.state['state'] = 'identity_mismatch_no_change'
        elif all(c['decision'] == 'DO_NOT_ENFORCE' for c in caches.values()):
            self.state['state'] = 'google_verdict_allows'
        elif any(c['decision'] == 'UNKNOWN' for c in caches.values()):
            self.state['state'] = 'unknown_verdict_no_change'
        elif self.state.get('attempted'):
            self.state['state'] = 'google_still_rejects_no_retry'
        else:
            # Persist before the action: a process/guest restart cannot make an
            # unresolved server rejection loop through repeated app restarts.
            self.state.update(attempted=True, state='refresh_requested',
                              previousCaches={k: v['sha256'] for k, v in caches.items()})
            self.save()
            self.refresh(caches)
        self.save()

    def run(self):
        while not self.runtime.stopping.is_set():
            try:
                self.tick()
                if self.state.get('state') in ('google_verdict_allows', 'google_still_rejects_no_retry',
                                              'identity_mismatch_no_change', 'unknown_verdict_no_change'):
                    return
            except Exception:
                # Google availability cannot break Android, its camera or viewer.
                # No raw exception output: adb errors may include private content.
                self.state['state'] = 'check_unavailable_no_change'
                try:
                    self.save()
                except OSError:
                    pass
            if self.runtime.stopping.wait(30):
                return


def install(network, directory='/phone', marker='/opt/teamaibox/google-play-experiment.json'):
    if not Path(marker).is_file():
        return
    base = network.NetworkRuntime

    class GoogleRuntime(base):
        def save(self):
            super().save()
            if self.status.get('phase') == 'running' and not hasattr(self, '_google_recovery'):
                self._google_recovery = GoogleCacheRecovery(self, directory)
                threading.Thread(target=self._google_recovery.run, daemon=True,
                                 name='google-registration-recovery').start()

    network.NetworkRuntime = GoogleRuntime
