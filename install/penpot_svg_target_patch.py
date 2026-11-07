"""Fence native plugin SVG and asynchronous raster insertion to their source page."""
from pathlib import Path
import hashlib
from offline_common import need

INPUTS = {
    'frontend/src/app/plugins/api.cljs': 'de7e3e87df7260c20ef0d246e5b7e94b0842e0f36d202ddf9e8d85dac4f36992',
    'frontend/src/app/main/data/workspace/media.cljs': '60f1b22cb98e82a5760523edc5a788dd502438b36ffebb1aebcef37aa7529852',
}


def verify(source):
    for relative, expected in INPUTS.items():
        need(hashlib.sha256((Path(source) / relative).read_bytes()).hexdigest() == expected,
             'native SVG patch source mismatch: ' + relative)


def patch(source):
    verify(source)
    source = Path(source)
    api = source / 'frontend/src/app/plugins/api.cljs'
    content = api.read_text()
    for method in ('createShapeFromSvg', 'createShapeFromSvgWithImages'):
        old = ':' + method + '\n    (fn [svg-string]'
        need(content.count(old) == 1, 'native SVG guard signature mismatch: ' + method)
        content = content.replace(old, ':' + method + '\n    (fn [svg-string target-guard]')
    old = '(dwm/create-svg-shape id "svg" svg-string (gpt/point 0 0))'
    need(content.count(old) == 1, 'native synchronous SVG patch context mismatch')
    content = content.replace(old, '(dwm/create-svg-shape id "svg" svg-string (gpt/point 0 0)\n'
        '                                            {:current-file-id file-id :current-page-id page-id :active? target-guard})')
    old = '#(resolve (shape/shape-proxy plugin-id file-id page-id id))\n                        reject)'
    need(content.count(old) == 1, 'native asynchronous SVG patch context mismatch')
    content = content.replace(old, '#(resolve (shape/shape-proxy plugin-id file-id page-id id))\n'
        '                        reject\n                        {:current-file-id file-id :current-page-id page-id :active? target-guard})')
    api.write_text(content)
    media = source / 'frontend/src/app/main/data/workspace/media.cljs'
    content = media.read_text()
    for old, new in [
        ('  [image {:keys [x y]}]\n  (ptk/reify ::image-uploaded\n    ptk/WatchEvent\n    (watch [_ _ _]\n      (let',
         '  [image {:keys [x y]} target]\n  (ptk/reify ::image-uploaded\n    ptk/WatchEvent\n    (watch [_ state _]\n      (when (= target (select-keys state [:current-file-id :current-page-id]))\n        (let'),
        ('(rx/of (dwsh/create-and-add-shape :rect x y shape))))))',
         '(rx/of (dwsh/create-and-add-shape :rect x y shape)))))))'),
        ('  (let [params (assoc params\n                      :local? true\n                      :on-image #(st/emit! (image-uploaded % position))',
         '  (let [target (select-keys @st/state [:current-file-id :current-page-id])\n        params (assoc params\n                      :local? true\n                      :on-image #(st/emit! (image-uploaded % position target))'),
    ]:
        need(content.count(old) == 1, 'native raster target patch context mismatch')
        content = content.replace(old, new)
    start = content.index('(defn create-svg-shape\n')
    old = content[start:]
    # Both functions are at the end of this exact pinned source file. Refuse
    # applying to an expanded tail rather than accidentally discarding new code.
    need(old.count('(defn ') == 2 and old.rstrip().endswith('(rx/catch on-error)))))'),
         'native SVG patch tail mismatch')
    overlay = Path(__file__).resolve().parent / 'penpot-patches/svg-target-functions.cljs'
    media.write_text(content[:start] + overlay.read_text())
