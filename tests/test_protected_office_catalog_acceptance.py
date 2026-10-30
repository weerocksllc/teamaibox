"""Mutation checks for the focused catalog evidence boundary."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from run_protected_office_catalog_acceptance_v2 import APPLICATIONS, check_catalog


def valid_probe():
    return {
        'internalComponentDiagnostic':True,'browserAccepted':False,'queuedWork':False,
        'inspections':[{'healthy':True,'state':'running','identityDifferences':[]} for _ in range(6)],
        'applications':[{'key':key,'launchable':True,'blockers':[],
            'models':[{'selectedProfile':'protected.example'}]} for key in APPLICATIONS],
        'availability':[{'applicationKey':key,'state':'available'} for key in APPLICATIONS],
        'deniedApplications':[{'key':key,'launchable':False,'blockers':['authorization_denied']}
            for key in APPLICATIONS],
    }


class CatalogAcceptanceTests(unittest.TestCase):
    def test_valid_internal_scope(self):
        check_catalog(valid_probe())

    def test_no_browser_claim_from_internal_probe(self):
        value=valid_probe(); value['browserAccepted']=True
        with self.assertRaises(ValueError): check_catalog(value)

    def test_actual_image_identity_mismatch_is_rejected(self):
        value=valid_probe(); value['inspections'][0]['identityDifferences']=[
            {'field':'imageDigest','expected':'sha256:expected','actual':'sha256:wrong'}]
        with self.assertRaises(ValueError): check_catalog(value)

    def test_missing_inspection_is_rejected(self):
        value=valid_probe(); value['inspections'].pop()
        with self.assertRaises(ValueError): check_catalog(value)

    def test_status_strip_cannot_disagree(self):
        value=valid_probe(); value['availability'][0]['state']='unavailable'
        with self.assertRaises(ValueError): check_catalog(value)

    def test_authorization_must_still_be_enforced(self):
        value=valid_probe(); value['deniedApplications'][0]['launchable']=True
        with self.assertRaises(ValueError): check_catalog(value)


if __name__=='__main__': unittest.main()
