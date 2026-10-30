import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import casting_browser_av_probe as probe


def events(offset=0, step=.016):
    return [dict(lo=s + offset - step, hi=s + offset, estimate=s + offset - step / 2) for s in probe.PULSES]


class BrowserAVTests(unittest.TestCase):
    def test_nonperiodic_sequence_and_correct_pairing(self):
        result = probe.checked_pairs(events(), events(.2), 0, 3)
        self.assertAlmostEqual(result['medianMs'], 200)
        self.assertEqual(result['count'], 10)

    def test_missing_extra_and_periodic_pulses_rejected(self):
        for data in (events()[:-1], events() + [events()[-1]],
                     [dict(lo=i * 2, hi=i * 2 + .01, estimate=i * 2 + .005) for i in range(10)]):
            with self.assertRaises(ValueError):
                probe.sequence(data)

    def test_wrong_phase_rejected_even_with_ten_events(self):
        wrong = events()
        wrong[3] = dict(lo=wrong[3]['lo'] + 1, hi=wrong[3]['hi'] + 1, estimate=wrong[3]['estimate'] + 1)
        with self.assertRaises(ValueError):
            probe.checked_pairs(events(), wrong, 0, 3)

    def test_unknown_camera_cannot_accept_sync(self):
        glass = probe.checked_pairs(events(), events(.2), 0, 3)
        av = probe.checked_pairs(events(.2), events(.22, .001), -2, 2)
        result = probe.budget_result(glass, av, None, None, None)
        self.assertTrue(result['glassBudgetPassed'])
        self.assertFalse(result['cameraBiasKnown'])
        self.assertFalse(result['browserAvBudgetPassed'])
        self.assertFalse(result['browserAvSyncAccepted'])

    def test_uncertainty_bounds_not_just_median(self):
        glass = probe.checked_pairs(events(), events(.2), 0, 3)
        av = probe.checked_pairs(events(.2), events(.22, .001), -2, 2)
        self.assertTrue(probe.budget_result(glass, av, 0, 5, 1)['browserAvBudgetPassed'])
        self.assertFalse(probe.budget_result(glass, av, 0, 100, 1)['browserAvBudgetPassed'])
        # Even calibrated recording metrics alone never bind the actual product.
        self.assertFalse(probe.budget_result(glass, av, 0, 5, 1)['browserAvSyncAccepted'])

    def test_slow_actual_measurement_is_reported_not_discarded(self):
        glass = probe.checked_pairs(events(), events(1.4), -.5, 3)
        av = probe.checked_pairs(events(1.4), events(1.42, .001), -2, 2)
        self.assertAlmostEqual(glass['medianMs'], 1400)
        self.assertFalse(probe.budget_result(glass, av, 0, 5, 1)['glassBudgetPassed'])

    def test_nan_negative_and_infinite_calibration_rejected(self):
        glass = probe.checked_pairs(events(), events(.2), 0, 3)
        av = probe.checked_pairs(events(.2), events(.22, .001), -2, 2)
        for bias, uncertainty, distance in ((math.nan, 1, 1), (0, -1, 1), (0, 1, -1), (0, 1, math.inf)):
            with self.assertRaises(ValueError):
                probe.budget_result(glass, av, bias, uncertainty, distance)

    def test_optical_sampling_must_be_fine_enough(self):
        glass = probe.checked_pairs(events(step=.04), events(.2, step=.04), -.5, 3)
        av = probe.checked_pairs(events(.2), events(.22, .001), -2, 2)
        self.assertFalse(probe.budget_result(glass, av, 0, 5, 1)['glassBudgetPassed'])


if __name__ == '__main__':
    unittest.main()
