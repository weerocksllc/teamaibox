"""Prevent a late pending notification after Penpot's blur-triggered save."""
import hashlib
from pathlib import Path

from offline_common import need

INPUT = 'frontend/src/app/main/data/persistence.cljs'
SHA256 = 'fa94e344c46f84c818574ab5f5b67387a1ebb5ceb66d15342b9feff9e7db8214'

PENDING_STREAM = b'''         (->> local-commits-s
              (rx/debounce 200)
              (rx/map (fn [_]
                        (update-status :pending)))
              (rx/take-until stoper-s))'''


def patch(source):
    path = Path(source) / INPUT
    original = path.read_bytes()
    need(hashlib.sha256(original).hexdigest() == SHA256, 'native save-status patch source mismatch')
    need(original.count(PENDING_STREAM) == 1, 'native save-status patch context mismatch')
    # Check after the debounce, at delivery time. A blur may already have
    # flushed the buffer and the runner may have acknowledged the commit.
    # Do not change queued writes, acknowledgement, error, or retry paths.
    guarded = PENDING_STREAM.replace(
        b'              (rx/debounce 200)\n',
        b'              (rx/debounce 200)\n'
        b'              ;; A blur flush can finish before this notification.\n'
        b'              (rx/filter (fn [_] @buffered?))\n',
    )
    path.write_bytes(original.replace(PENDING_STREAM, guarded))
