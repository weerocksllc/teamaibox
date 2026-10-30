import json
import unittest

from server import bounded_box, recognition_prompt, recognized_content, spotting_blocks, structured_region


class SpottingParserTests(unittest.TestCase):
    def test_parses_paddle_arrays_and_scales_normalized_coordinates(self):
        content = json.dumps({"spotting_res": {"rec_texts": ["团队 AI 盒子"], "rec_boxes": [[0.1, 0.2, 0.8, 0.4]], "rec_scores": [0.98]}})
        self.assertEqual(spotting_blocks(content, 1000, 500), [{
            "block_id": 1, "block_bbox": [100.0, 100.0, 800.0, 200.0], "block_label": "text",
            "block_content": "团队 AI 盒子", "block_score": 0.98,
        }])

    def test_parses_fenced_quad_items(self):
        content = '```json\n[{"text":"hello","points":[[1,2],[10,2],[10,8],[1,8]]}]\n```'
        self.assertEqual(spotting_blocks(content, 20, 20)[0]["block_bbox"], [1.0, 2.0, 10.0, 2.0, 10.0, 8.0, 1.0, 8.0])

    def test_parses_native_paddle_location_token_quadrilaterals(self):
        content = (
            "凤台路<|LOC_286|><|LOC_142|><|LOC_527|><|LOC_158|>"
            "<|LOC_522|><|LOC_264|><|LOC_282|><|LOC_249|>\n"
            "Future Road<|LOC_571|><|LOC_189|><|LOC_758|><|LOC_204|>"
            "<|LOC_754|><|LOC_291|><|LOC_567|><|LOC_276|>"
        )
        blocks = spotting_blocks(content, 1000, 500)
        self.assertEqual(blocks[0]["block_content"], "凤台路")
        self.assertEqual(blocks[0]["block_bbox"], [286.0, 71.0, 527.0, 79.0, 522.0, 132.0, 282.0, 124.5])
        self.assertEqual(blocks[1]["block_content"], "Future Road")
        self.assertIsNone(blocks[1]["block_score"])

    def test_rejects_incomplete_or_out_of_range_location_tokens(self):
        with self.assertRaisesRegex(ValueError, "neither JSON nor valid"):
            spotting_blocks("text<|LOC_1|><|LOC_2|>", 100, 100)
        with self.assertRaisesRegex(ValueError, "invalid"):
            spotting_blocks("text" + "<|LOC_1001|>" * 8, 100, 100)

    def test_rejects_missing_or_out_of_image_geometry(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            bounded_box(None, 100, 100)
        with self.assertRaisesRegex(ValueError, "outside"):
            bounded_box([0, 0, 500, 10], 100, 100)

    def test_rejects_plain_text_instead_of_fabricating_a_page(self):
        with self.assertRaisesRegex(ValueError, "neither JSON nor valid"):
            spotting_blocks("recognized text without coordinates", 100, 100)

    def test_maps_layout_labels_to_native_vlm_tasks(self):
        self.assertEqual(recognition_prompt("text"), "OCR:")
        self.assertEqual(recognition_prompt("table"), "Table Recognition:")
        self.assertEqual(recognition_prompt("display_formula"), "Formula Recognition:")
        self.assertEqual(recognition_prompt("chart"), "Chart Recognition:")
        self.assertEqual(recognition_prompt("seal"), "Seal Recognition:")
        self.assertIsNone(recognition_prompt("image"))
        with self.assertRaisesRegex(ValueError, "unsupported"):
            recognition_prompt("unknown")

    def test_normalizes_bounded_region_content(self):
        self.assertEqual(recognized_content("```markdown\nhello\n```"), "hello")
        with self.assertRaisesRegex(ValueError, "invalid"):
            recognized_content("  ")

    def test_marks_formula_and_converts_table_content(self):
        formula, content_format, structure = structured_region("display_formula", r"x^2 + y^2")
        self.assertEqual((formula, content_format, structure), (r"x^2 + y^2", "latex", None))
        content, content_format, structure = structured_region(
            "table", "<fcel>Team<fcel>AI<nl><fcel>Box<ecel><nl>"
        )
        self.assertEqual(content_format, "html")
        self.assertEqual(structure["rows"], 2)
        self.assertEqual(structure["columns"], 2)
        self.assertEqual(content, "<table><tr><td>Team</td><td>AI</td></tr><tr><td>Box</td><td></td></tr></table>")


if __name__ == "__main__":
    unittest.main()
