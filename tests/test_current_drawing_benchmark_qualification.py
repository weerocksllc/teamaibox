import unittest

from tools import drawing_benchmark_probe as probe


class DrawingBenchmarkContractTest(unittest.TestCase):
    def test_request_body_is_bounded_and_reproducible(self):
        value = probe.request_body(42, 20, "safe synthetic prompt")
        self.assertEqual(value["model"], probe.MODEL)
        self.assertEqual(value["size"], "512x512")
        self.assertEqual(value["x_teamaibox"]["seed"], 42)
        self.assertEqual(value["x_teamaibox"]["steps"], 20)
        self.assertEqual(value["x_teamaibox"]["output_format"], "png")


if __name__ == "__main__":
    unittest.main()
