"""Isolated preparation checks; native async behavior is a separate browser gate."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch as mock_patch
from offline_common import InstallError
import penpot_svg_target_patch as overlay


class SvgTargetPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.api = self.root / 'frontend/src/app/plugins/api.cljs'
        self.media = self.root / 'frontend/src/app/main/data/workspace/media.cljs'
        self.api.parent.mkdir(parents=True)
        self.media.parent.mkdir(parents=True)
        self.api.write_text(':createShapeFromSvg\n    (fn [svg-string]\n'
            ':createShapeFromSvgWithImages\n    (fn [svg-string]\n'
            '(dwm/create-svg-shape id "svg" svg-string (gpt/point 0 0))\n'
            '#(resolve (shape/shape-proxy plugin-id file-id page-id id))\n                        reject)')
        self.media.write_text('(ns isolated.fixture)\n'
            '(defn image-uploaded\n  [image {:keys [x y]}]\n  (ptk/reify ::image-uploaded\n'
            '    ptk/WatchEvent\n    (watch [_ _ _]\n      (let [shape image]\n'
            '        (rx/of (dwsh/create-and-add-shape :rect x y shape))))))\n'
            '(defn upload-media-workspace\n  [params]\n  (let [params (assoc params\n'
            '                      :local? true\n                      :on-image #(st/emit! (image-uploaded % position)))] params))\n'
            '(defn create-svg-shape\n [] nil)\n'
            '(defn create-svg-shape-with-images\n (rx/catch on-error)))))\n')
        self.inputs = {str(path.relative_to(self.root)): hashlib.sha256(path.read_bytes()).hexdigest()
                       for path in (self.api, self.media)}

    def test_plugin_targets_are_captured_and_manual_arities_remain(self):
        with mock_patch.object(overlay, 'INPUTS', self.inputs):
            overlay.patch(self.root)
        self.assertEqual(self.api.read_text().count(':active? target-guard}'), 2)
        self.assertEqual(self.api.read_text().count('(fn [svg-string target-guard]'), 2)
        result = self.media.read_text()
        self.assertTrue(result.startswith('(ns isolated.fixture)\n'))
        self.assertIn('(create-svg-shape id name svg-string position nil)', result)
        self.assertIn('on-success on-error nil)', result)
        self.assertEqual(result.count('(check-plugin-svg-target target)'), 3)
        self.assertIn('(not (true? (active?)))', result)
        self.assertIn('(catch :default _ true)', result)
        self.assertIn('(image-uploaded % position target)', result)
        self.assertIn('(when (= target (select-keys state [:current-file-id :current-page-id]))', result)

    def test_changed_input_is_refused_before_editing(self):
        before = self.api.read_bytes()
        self.media.write_text(self.media.read_text() + '\n;; unexpected change\n')
        with mock_patch.object(overlay, 'INPUTS', self.inputs):
            with self.assertRaises(InstallError):
                overlay.patch(self.root)
        self.assertEqual(self.api.read_bytes(), before)

    def test_patch_cannot_be_reapplied(self):
        with mock_patch.object(overlay, 'INPUTS', self.inputs):
            overlay.patch(self.root)
            with self.assertRaises(InstallError):
                overlay.patch(self.root)


if __name__ == '__main__':
    unittest.main()
