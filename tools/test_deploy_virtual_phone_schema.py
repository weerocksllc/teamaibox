import unittest
from deploy_virtual_phone_schema import expected,statement

class PhoneSchemaTests(unittest.TestCase):
    def test_atomic_additive_two_steps(self):
        old={k:v for k,v in expected().items() if int(k)<=78};sql=statement(old)
        self.assertTrue(sql.startswith('BEGIN ISOLATION LEVEL REPEATABLE READ;'))
        self.assertTrue(sql.endswith('COMMIT;'))
        self.assertEqual(sql.count('INSERT INTO public.teamaibox_schema_migrations'),2)
        self.assertIn("SET LOCAL lock_timeout='3s'",sql)
        self.assertNotIn('DROP TABLE',sql)
        self.assertNotIn('UPDATE iam.identities',sql)
    def test_exact_retry_does_not_reapply(self):
        sql=statement(expected());self.assertNotIn('CREATE TABLE',sql)
        self.assertNotIn('INSERT INTO public.teamaibox_schema_migrations',sql)
    def test_partial_or_drifted_ledger_rejected(self):
        for value in [{},dict(expected(),**{'78':'0'*64}),{k:v for k,v in expected().items() if k!='80'}]:
            with self.subTest(value=len(value)),self.assertRaises((RuntimeError,AssertionError)):statement(value)

if __name__=='__main__':unittest.main()
