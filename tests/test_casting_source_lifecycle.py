"""Only fixed native lifecycle events can change sender status."""
import os
from types import SimpleNamespace
from threading import Event, Thread
import unittest
from services.trusted_media_service.native_receiver_process import NativeReceiverProcess
from services.trusted_media_service.media_progress import project_progress, validate_progress

class SourceLifecycleTest(unittest.TestCase):
    def test_fixed_events_fragmentation_and_no_private_text(self):
        reader, writer = os.pipe()
        stream = os.fdopen(reader, 'rb', buffering=0)
        receiver = SimpleNamespace(_process=SimpleNamespace(stderr=stream), _source_state='waiting',
            _source_state_revision=1, _geometry=None, _assertion_code=None)
        def write():
            try:
                for part in (b'private sender disconnected\n', b'TBS1 ', b'1\n', b'TBS1 0 private\n', b'x'*4096+b'\n', b'TBS1 0\n'):
                    os.write(writer, part)
            finally: os.close(writer)
        thread=Thread(target=write);thread.start()
        try: NativeReceiverProcess._read_assertion(receiver)
        finally: stream.close();thread.join(2)
        self.assertEqual(receiver._source_state,'disconnected')
        self.assertEqual(receiver._source_state_revision,3)
        self.assertIsNone(receiver._geometry)
        self.assertIsNone(receiver._assertion_code)

    def test_connection_event_never_bypasses_pairing(self):
        receiver=SimpleNamespace(_closed=Event(),_source_state='connected',authorized_source_id=lambda:None)
        self.assertEqual(NativeReceiverProcess.source_state(receiver),'waiting')
        receiver.authorized_source_id=lambda:'authenticated-memory-only-id'
        self.assertEqual(NativeReceiverProcess.source_state(receiver),'connected')
        receiver._source_state='disconnected'
        self.assertEqual(NativeReceiverProcess.source_state(receiver),'disconnected')

    def test_health_projects_only_fixed_state_not_sender_data(self):
        v=project_progress({}, {}, source_state='disconnected', source_state_revision=3)
        self.assertEqual(v['sourceState'],'disconnected')
        self.assertEqual(v['sourceStateRevision'],3)
        for state in ('private-source',True,123,None):
            with self.assertRaises(ValueError): validate_progress({**v,'sourceState':state})
        for revision in (0, True, 2**53):
            with self.assertRaises(ValueError): validate_progress({**v,'sourceStateRevision':revision})
        with self.assertRaises(ValueError): validate_progress({key:value for key,value in v.items() if key!='sourceStateRevision'})

if __name__=='__main__':unittest.main()
