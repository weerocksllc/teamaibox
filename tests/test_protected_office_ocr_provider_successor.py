import unittest

from tools import build_protected_office_ocr_provider_successor as runner
from tools import validate_protected_office_ocr_provider_successor as validator


class ProtectedOfficeOcrProviderSuccessorTest(unittest.TestCase):
    def test_exact_base_is_shared(self) -> None:
        self.assertEqual(runner.BASE_IMAGE_ID, validator.BASE_IMAGE_ID)

    def test_sources_are_shared(self) -> None:
        self.assertEqual(runner.SOURCES, validator.SOURCES)

    def test_run_id_is_bounded(self) -> None:
        self.assertIsNotNone(runner.RUN_ID.fullmatch("protected-office-ocr-provider-build-20260906-a1"))
        self.assertIsNone(runner.RUN_ID.fullmatch("../unsafe"))


if __name__ == "__main__":
    unittest.main()
