"""Synthetic boot-state tests; real whole-host restart remains a separate gate."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock,patch

path=Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish/phone_boot_resume.py'
spec=importlib.util.spec_from_file_location('boot_resume',path)
boot=importlib.util.module_from_spec(spec);spec.loader.exec_module(boot)
OLD='11111111-1111-4111-8111-111111111111';NEW='22222222-2222-4222-8222-222222222222'


class BootResumeTests(unittest.TestCase):
    def test_private_umask_still_gives_agent_directory_traversal(self):
        import os,stat,tempfile
        with tempfile.TemporaryDirectory() as d,patch.object(boot.os,'chown') as chown:
            root=Path(d)/'socket';previous=os.umask(0o077)
            try:boot.create_socket_directory(root)
            finally:os.umask(previous)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode),0o750)
            chown.assert_called_once_with(root,0,10001)

    def test_existing_directory_permissions_are_not_silently_changed(self):
        import os,stat,tempfile
        with tempfile.TemporaryDirectory() as d,patch.object(boot.os,'chown') as chown:
            root=Path(d)/'socket';root.mkdir(mode=0o700)
            boot.create_socket_directory(root)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode),0o700);chown.assert_not_called()

    def test_daemon_mount_reordering_preserves_exact_identity(self):
        import json
        mounts=[dict(Destination='/one',Source='/source/one',RW=False),dict(Destination='/two',Source='/source/two',RW=True)]
        host=[dict(Target='/one',Source='/source/one',ReadOnly=True),dict(Target='/two',Source='/source/two',ReadOnly=False)]
        value=dict(Id='exact-id',Image='exact-image',Config={'User':'10001'},Mounts=mounts[::-1],HostConfig={'Mounts':host[::-1]})
        p=dict(agent=dict(id='exact-id',image='exact-image',user='10001',mounts=mounts,hostConfig={'Mounts':host}))
        with patch.object(boot,'execute',return_value=json.dumps([value]).encode()):self.assertEqual(boot.agent_info(p),value)
        for field,new in [('Source','/another'),('RW',True)]:
            changed=json.loads(json.dumps(value));changed['Mounts'][1][field]=new
            with self.subTest(field=field),patch.object(boot,'execute',return_value=json.dumps([changed]).encode()),self.assertRaises(RuntimeError):boot.agent_info(p)

    def test_duplicate_mounts_are_not_hidden_by_sorting(self):
        with self.assertRaisesRegex(RuntimeError,'duplicate_mount'):
            boot.canonical_mounts([dict(Destination='/same'),dict(Destination='/same')],'Destination')

    def test_same_boot_does_not_undo_manual_stop(self):
        self.assertFalse(boot.boot_needed(dict(version=1,completedBootId=OLD),OLD))
        self.assertTrue(boot.boot_needed(dict(version=1,completedBootId=OLD),NEW))

    def test_invalid_ack_not_treated_as_new_empty_phone(self):
        for ack in ({},dict(version=2,completedBootId=OLD),dict(version=1,completedBootId='bad'),
                    dict(version=1,completedBootId=OLD,reset=True)):
            with self.subTest(ack=ack),self.assertRaises((RuntimeError,ValueError,KeyError)):boot.boot_needed(ack,NEW)

    def test_acknowledged_boot_does_not_inspect_user_guest_or_export_key(self):
        with patch.object(boot,'status',return_value={'status':'already-current'}),patch.object(boot,'pool_module') as pool:
            self.assertEqual(boot.resume({}),{'status':'already-current'});pool.assert_not_called()

    def test_primary_is_quiet_and_never_reads_key_on_same_boot(self):
        p=dict(primaryHost='spark-20')
        with patch.object(boot.socket,'gethostname',return_value='spark-20'),patch.object(boot,'remote',return_value=['check']),\
             patch.object(boot,'execute',return_value=b'{"status":"already-current"}'),patch.object(boot.subprocess,'Popen') as spawn:
            boot.primary(p);spawn.assert_not_called()

    def test_open_pool_resume_does_not_export_key(self):
        p=dict(primaryHost='spark-20')
        with patch.object(boot.socket,'gethostname',return_value='spark-20'),patch.object(boot,'remote',side_effect=lambda p,a:[a]),\
             patch.object(boot,'execute',side_effect=[b'{"status":"pending","poolState":"open"}',b'{"status":"restored"}']) as execute,\
             patch.object(boot.subprocess,'Popen') as spawn:
            boot.primary(p);spawn.assert_not_called();self.assertEqual(execute.call_args_list[-1].args[0],['resume'])

    def test_uncertain_node_state_never_exports_key(self):
        with patch.object(boot.socket,'gethostname',return_value='spark-20'),patch.object(boot,'remote',return_value=['check']),\
             patch.object(boot,'execute',return_value=b'{"status":"pending","poolState":"unknown"}'),patch.object(boot.subprocess,'Popen') as spawn:
            with self.assertRaises(RuntimeError):boot.primary(dict(primaryHost='spark-20'))
            spawn.assert_not_called()

    def test_new_boot_with_active_phone_refuses_before_key_or_agent(self):
        with patch.object(boot.socket,'gethostname',return_value='spark-19'),\
             patch.object(boot,'read_private',return_value=('{"version":1,"completedBootId":"'+OLD+'"}').encode()),\
             patch.object(boot,'current_boot',return_value=NEW),patch.object(boot,'active_phones',return_value=['existing']),\
             patch.object(boot,'agent_info') as agent,patch.object(boot,'pool_module') as pool:
            with self.assertRaisesRegex(RuntimeError,'maintenance'):boot.status(dict(nodeHost='spark-19',stage='/test'))
            agent.assert_not_called();pool.assert_not_called()

    def test_new_boot_uncertain_mapper_is_not_opened_again(self):
        module=Mock();module.inspect_pool.side_effect=RuntimeError('bad_mapping')
        with patch.object(boot.socket,'gethostname',return_value='spark-19'),\
             patch.object(boot,'read_private',return_value=('{"version":1,"completedBootId":"'+OLD+'"}').encode()),\
             patch.object(boot,'current_boot',return_value=NEW),patch.object(boot,'active_phones',return_value=[]),\
             patch.object(boot,'agent_info'),patch.object(boot,'verify_files'),\
             patch.object(boot,'pool_module',return_value=(module,{})),patch.object(boot.os.path,'lexists',return_value=True),\
             patch.object(boot.os.path,'ismount',return_value=False):
            with self.assertRaisesRegex(RuntimeError,'bad_mapping'):
                boot.status(dict(nodeHost='spark-19',stage='/test',nodeFiles={},poolId='id',root='/test'))
            module.reopen.assert_not_called()


if __name__=='__main__':unittest.main()
