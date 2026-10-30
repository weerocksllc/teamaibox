import unittest

import numpy as np

from layout_onnx import parse_layout_boxes


class LayoutPostprocessingTests(unittest.TestCase):
    def test_sorts_by_reading_order_and_maps_labels(self):
        value = np.array([
            [22, .91, 10, 10, 80, 30, 9],
            [6, .95, 5, 2, 90, 9, 1],
            [21, .2, 5, 40, 90, 80, 10],
        ], dtype=np.float32)
        blocks = parse_layout_boxes(value, .3, 100, 100)
        self.assertEqual([block.label for block in blocks], ["doc_title", "text"])

    def test_removes_contained_same_label_and_cross_class_duplicates(self):
        value = np.array([
            [22, .9, 0, 0, 90, 90, 1],
            [22, .8, 10, 10, 80, 80, 2],
            [4, .7, 0, 0, 90, 90, 3],
        ], dtype=np.float32)
        blocks = parse_layout_boxes(value, .3, 100, 100)
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0].label, "text")

    def test_rejects_invalid_shape_label_and_geometry(self):
        with self.assertRaisesRegex(ValueError, "tensor"):
            parse_layout_boxes(np.zeros((1, 6), np.float32), .3, 100, 100)
        with self.assertRaisesRegex(ValueError, "region"):
            parse_layout_boxes(np.array([[99, .9, 0, 0, 1, 1, 0]], np.float32), .3, 100, 100)
        with self.assertRaisesRegex(ValueError, "geometry"):
            parse_layout_boxes(np.array([[22, .9, 20, 20, 10, 10, 0]], np.float32), .3, 100, 100)
        with self.assertRaisesRegex(ValueError, "geometry"):
            parse_layout_boxes(np.array([[22, .9, -10, 0, 90, 90, 0]], np.float32), .3, 100, 100)

    def test_clamps_only_bounded_edge_overshoot(self):
        blocks = parse_layout_boxes(
            np.array([[21, .9, -.15, -.01, 100.4, 101.5, 0]], np.float32), .3, 100, 100
        )
        self.assertEqual(blocks[0].box, (0.0, 0.0, 100.0, 100.0))


if __name__ == "__main__":
    unittest.main()
