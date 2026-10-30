"""Content-free geometry, never a crop rectangle or readiness/authentication proof."""
import re

FIELDS = ('sourceWidth', 'sourceHeight', 'displayWidth', 'displayHeight')
_LINE = re.compile(rb'TBG1 ([0-9]{2,4}) ([0-9]{2,4}) ([0-9]{2,4}) ([0-9]{2,4})\n')


def parse_geometry(line):
    if not isinstance(line, bytes) or len(line) > 32:
        return None
    match = _LINE.fullmatch(line)
    if match is None:
        return None
    values = tuple(int(x) for x in match.groups())
    return dict(zip(FIELDS, values)) if all(16 <= x <= 8192 for x in values) else None
