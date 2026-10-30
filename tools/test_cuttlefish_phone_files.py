import fcntl
import hashlib
import io
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish'))
from phone_files import PhoneFiles, PhoneError, END, MAXIMUM, file_name, request


class FilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='phone-file-test-')
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        (self.data/'exchange').mkdir(mode=0o700)
        self.config = dict(version=1, phoneId=str(uuid.uuid4()), ownerId=str(uuid.uuid4()), volumeId=str(uuid.uuid4()),
                           runId=str(uuid.uuid4()), generation=1, buildId='16102939', instance=21)
        self.worker = PhoneFiles(self.config, data=self.data)
        self.content = b'synthetic input\x00\xff' * 4096
        self.calls=[]
        # Only Android command execution is a fixture, never a product result.
        def run(script, directory, deadline, *, input_file=None, binary=False):
            self.calls.append(script)
            if input_file:
                self.assertEqual(input_file.read(), self.content)
                self.assertEqual(input_file.name, str(directory/'input'))
            result=(b'Success\n' if script.startswith('cmd package install ') else
                    b'5\0test.txt\0' if "for path" in script else self.content if binary else
                    hashlib.sha256(self.content).hexdigest().encode()+b'  file\n')
            output=directory/'output'; output.write_bytes(result)
            return output
        self.worker._run=run

    def job(self, action='upload', **changes):
        value={k:self.config[k] for k in ('phoneId','ownerId','runId','generation')}
        value.update(action=action, transferId=str(uuid.uuid4()), deadline=int(time.time()*1000)+10000)
        if action!='list': value['name']='会议.txt'
        if action in ('upload','install'):
            value.update(sizeBytes=len(self.content), sha256=hashlib.sha256(self.content).hexdigest())
        return value | changes

    def assertClean(self):
        self.assertEqual([p.name for p in (self.data/'exchange').iterdir()],['.file-transfer.lock'])

    def test_fixed_upload_install_list_download_and_exact_staging_cleanup(self):
        result=self.worker.execute(self.job(),io.BytesIO(self.content+END))
        self.assertTrue(result['stored']); self.assertClean()
        script=self.calls[-1]
        self.assertIn('exec 3>"$temporary"',script)
        self.assertIn('mv -nT -- "$temporary" "$name"',script)
        result=self.worker.execute(self.job('install'),io.BytesIO(self.content+END))
        self.assertTrue(result['installed']); self.assertClean()
        self.assertEqual(self.calls[-1],f'cmd package install -r -S {len(self.content)} -- -')
        result=self.worker.execute(self.job('list'),io.BytesIO())
        self.assertEqual(result['files'],[dict(name='test.txt',sizeBytes=5)]); self.assertClean()
        def consume(metadata, stream):
            self.assertEqual(stream.read(),self.content)
            self.assertEqual(metadata['sha256'],hashlib.sha256(self.content).hexdigest())
            return metadata
        self.worker.execute(self.job('download'),io.BytesIO(),consume)
        self.assertIn('readlink -f /proc/$$/fd/3',self.calls[-1]); self.assertClean()

    def test_truncated_oversized_changed_digest_and_extra_bytes_never_reach_android(self):
        for body in (self.content[:-1],self.content+b'wrong',self.content+END+b'extra'):
            with self.assertRaisesRegex(PhoneError,'phone_object_invalid'):
                self.worker.execute(self.job(),io.BytesIO(body))
            self.assertClean()
        with self.assertRaisesRegex(PhoneError,'phone_object_invalid'):
            self.worker.execute(self.job(sha256='0'*64),io.BytesIO(self.content+END))
        with self.assertRaisesRegex(PhoneError,'phone_upload_too_large'):
            self.worker.execute(self.job(sizeBytes=MAXIMUM+1),io.BytesIO())
        self.assertEqual(self.calls,[])

    def test_closed_request_fences_phone_run_paths_size_and_deadline(self):
        for value in (self.job(hostPath='/etc/passwd'),self.job(ownerId=str(uuid.uuid4())),self.job(generation=True),
                      self.job(action='shell'),self.job(deadline=int(time.time()*1000)+121000),self.job(sizeBytes=True)):
            with self.assertRaises(PhoneError): request(value,self.config)
        for name in ('..','../x','a/b','a\\b','x\x00','x\u202ey','.transfer-private',' name'):
            with self.assertRaises(PhoneError): file_name(name)
        # Quotes/shell metacharacters are names, safely quoted in a fixed script.
        name="notes'; touch HACKED; ' $(whoami).txt"
        self.worker.execute(self.job(name=name),io.BytesIO(self.content+END))
        import shlex
        self.assertIn('name='+shlex.quote(name),self.calls[-1])

    def test_list_has_no_two_hundred_file_cap(self):
        def run(script,directory,*_,**kwargs):
            self.assertNotIn('-le 200',script)
            output=directory/'output';output.write_bytes(b''.join(str(i).encode()+b'\0file-'+str(i).encode()+b'.txt\0' for i in range(2500)));return output
        self.worker._run=run
        result=self.worker.execute(self.job('list'),io.BytesIO())
        self.assertEqual(len(result['files']),2500);self.assertClean()

    def test_admitted_operation_progress_continues_after_command_expiry(self):
        calls=[];self.worker.progress=lambda:calls.append(True)
        self.worker._check(time.monotonic()-121)
        self.assertEqual(calls,[True])

    def test_existing_transfer_directory_or_link_is_not_adopted_or_deleted(self):
        job=self.job(); directory=self.data/'exchange'/('transfer-'+job['transferId'])
        directory.mkdir(); (directory/'input').write_bytes(b'old, not owned by this call')
        with self.assertRaises(FileExistsError): self.worker.execute(job,io.BytesIO())
        self.assertEqual((directory/'input').read_bytes(),b'old, not owned by this call')
        self.assertEqual(self.calls,[])

    def test_parallel_worker_and_insecure_exchange_are_denied(self):
        lock=os.open(self.data/'exchange'/'.file-transfer.lock',os.O_RDWR|os.O_CREAT,0o600)
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(PhoneError,'phone_operation_conflict'):
                self.worker.execute(self.job(),io.BytesIO())
        finally: os.close(lock)
        os.chmod(self.data/'exchange',0o755)
        with self.assertRaisesRegex(PhoneError,'phone_storage_unavailable'):
            self.worker.execute(self.job(),io.BytesIO())
        self.assertEqual(self.calls,[])

    def test_failed_install_or_cancellation_does_not_report_success(self):
        def failed(script,directory,*args,**kwargs):
            out=directory/'output';out.write_bytes(b'Failure [INSTALL_FAILED_INVALID_APK]\n');return out
        self.worker._run=failed
        with self.assertRaisesRegex(PhoneError,'phone_install_failed'):
            self.worker.execute(self.job('install'),io.BytesIO(self.content+END))
        self.assertClean()
        self.worker.cancelled=lambda:True
        with self.assertRaisesRegex(PhoneError,'phone_grant_invalid'):
            self.worker.execute(self.job(),io.BytesIO(self.content+END))
        self.assertClean()


if __name__=='__main__': unittest.main()
