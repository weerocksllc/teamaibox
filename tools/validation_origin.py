"""Validate explicit diagnostic HTTPS origins without naming a development host."""
from urllib.parse import urlsplit


def is_https_origin(value, *, trailing_slash=False):
    if not isinstance(value,str) or any(c.isspace() for c in value):
        return False
    try:
        origin=urlsplit(value)
        port=origin.port
        return bool(origin.scheme=='https' and origin.hostname and
            '@' not in origin.netloc and not origin.username and not origin.password and
            origin.path==('/' if trailing_slash else '') and
            not origin.query and not origin.fragment and (port is None or 1<=port<=65535))
    except ValueError:
        return False
