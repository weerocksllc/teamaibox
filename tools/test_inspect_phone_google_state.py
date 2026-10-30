import unittest

from inspect_phone_google_state import diagnostic_logs


class GoogleDiagnosticLogsTests(unittest.TestCase):
    def test_checkin_not_generic_checking(self):
        report = diagnostic_logs('I/Satellite: Checking state\nI/Checkin (42): Checkin Succeeded: https://android.example/checkin')
        self.assertEqual(report['signals']['checkinSuccess'], 1)
        self.assertEqual(len(report['lines']), 1)
        self.assertNotIn('https:', report['lines'][0])

    def test_redacts_identifiers_credentials_and_account(self):
        report = diagnostic_logs('E/Checkin: account=user@example.org token=secret auth=other android_id=12345678901234 securityToken=abc serial=XYZ')
        line = report['lines'][0]
        for value in ('user@example.org', 'secret', 'other', '12345678901234', '=abc', '=XYZ'):
            self.assertNotIn(value, line)

    def test_adb_command_echo_is_not_evidence(self):
        report = diagnostic_logs("I/adbd (703): requested 'shell: echo FATAL EXCEPTION SERVICE_INVALID'")
        self.assertEqual(report['lines'], [])
        self.assertEqual(report['signals']['fatalException'], 0)

    def test_window_animation_is_not_google_service_evidence(self):
        report = diagnostic_logs('D/WindowManager: surface com.android.vending/com.google.android.gms.gmscompliance.ui.UncertifiedDeviceActivity')
        self.assertEqual(report['lines'], [])

    def test_repeated_errors_count_but_do_not_flood_output(self):
        line = 'E/GmsLogger( 42): ConnectionResult{statusCode=SERVICE_INVALID}'
        report = diagnostic_logs('\n'.join([line] * 100 + [line.replace('42', '99')]))
        self.assertEqual(report['signals']['serviceInvalid'], 101)
        self.assertEqual(len(report['lines']), 1)

    def test_output_is_bounded_and_does_not_infer_root_cause(self):
        report = diagnostic_logs('\n'.join(f'E/Checkin: event {i} ' + 'x' * 900 for i in range(70)))
        self.assertEqual(len(report['lines']), 40)
        self.assertTrue(all(len(line) <= 600 for line in report['lines']))
        self.assertNotIn('rootCause', report)


if __name__ == '__main__':
    unittest.main()
