"""Opt-in native download URL adaptation for the protected editor subpath."""
import hashlib
from pathlib import Path
import shutil
from offline_common import need

INPUT = 'frontend/src/app/util/dom.cljs'
SHA256 = '313b2d54cbd7ebb1388d44316ff7b93e46dfb693072d6bcf6318725082917549'


def patch(source):
    source = Path(source)
    path = source / INPUT
    need(hashlib.sha256(path.read_bytes()).hexdigest() == SHA256, 'native download patch source mismatch')
    text = path.read_text()
    replacements = [
        ('(ns app.util.dom\n  (:require\n', '(ns app.util.dom\n  (:require\n   ["./teamaibox_download.js" :as tab-download]\n'),
        ('    (obj/set! link "href" uri)', '    (obj/set! link "href" (tab-download/resolveDownload uri\n'
         '                            (obj/get globals/window "penpotProtectedDownloadsBase")\n'
         '                            (obj/get (obj/get globals/window "location") "origin")))'),
        ('response    (js/fetch uri)', 'response    (js/fetch (tab-download/resolveDownload uri\n'
         '                              (obj/get globals/window "penpotProtectedDownloadsBase")\n'
         '                              (obj/get (obj/get globals/window "location") "origin")))'),
    ]
    for old, new in replacements:
        need(text.count(old) == 1, 'native download patch context mismatch')
        text = text.replace(old, new)
    target = path.with_name('teamaibox_download.js')
    need(not target.exists(), 'native download helper already exists')
    shutil.copyfile(Path(__file__).parent / 'penpot-patches/ProtectedDownloadURL.mjs', target)
    path.write_text(text)
