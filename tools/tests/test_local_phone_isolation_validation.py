import copy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).parents[1]))
from validate_local_phone_isolation import ROOT, PARENTS, validate

class IsolationValidationTests(unittest.TestCase):
    def test_observed_records(self):
        records=[json.loads((ROOT/'evidence/validation/virtual-phones'/(n+'.json')).read_bytes()) for n in PARENTS]
        self.assertTrue(validate(records)['task3_5Satisfied'])

    def test_damaged_or_overclaimed_records_rejected(self):
        original=[json.loads((ROOT/'evidence/validation/virtual-phones'/(n+'.json')).read_bytes()) for n in PARENTS]
        mutations=[(0,'status','failed'),(0,'guestFirewallUnchanged',False),(1,'identitiesPreserved',False),
                   (2,'swapoutBytes',4096),(2,'oomKilled',True),(2,'noStopCommandIssuedByFixture',False),
                   (2,'originalPhoneRecordPreserved',False),(3,'phoneId','wrong'),(3,'fixtureFilesRemoved',False)]
        for index,key,value in mutations:
            with self.subTest(key=key):
                records=copy.deepcopy(original);records[index][key]=value
                with self.assertRaises(ValueError):validate(records)
        records=copy.deepcopy(original);records[3]['probe']['systemResolverCacheTested']=True
        with self.assertRaises(ValueError):validate(records)

if __name__=='__main__':unittest.main()
