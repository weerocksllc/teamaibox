import unittest

from otsl import convert_otsl


class OtslConversionTests(unittest.TestCase):
    def test_exports_escaped_rectangular_cells(self):
        value = convert_otsl("<fcel>A & B<fcel>C<nl><fcel>D<ecel><nl>")
        self.assertEqual((value["rows"], value["columns"]), (2, 2))
        self.assertEqual(value["html"], "<table><tr><td>A &amp; B</td><td>C</td></tr><tr><td>D</td><td></td></tr></table>")

    def test_preserves_horizontal_vertical_and_cross_spans(self):
        value = convert_otsl(
            "<fcel>merged<lcel><fcel>right<nl>"
            "<ucel><xcel><fcel>bottom<nl>"
        )
        merged = value["cells"][0]
        self.assertEqual((merged["row_span"], merged["column_span"]), (2, 2))
        self.assertIn('rowspan="2" colspan="2"', value["html"])

    def test_rejects_missing_full_cell_content_and_excess_dimensions(self):
        with self.assertRaisesRegex(ValueError, "missing content"):
            convert_otsl("<fcel><ecel><nl>")
        with self.assertRaisesRegex(ValueError, "dimensions"):
            convert_otsl(("<ecel>" * 4_097) + "<nl>")


if __name__ == "__main__":
    unittest.main()
