"""Apply the already-supported media-port bound to the installed older base.

The candidate inherits that base to preserve camera/shutdown behavior. Only this
stale two-instance check is reconciled with phone_runtime.py / phone_network.py.
"""
from pathlib import Path

path = Path('/opt/teamaibox/phone_runtime_base.py')
source = path.read_text()
old = "value['instance'] not in (21, 22)"
new = "not 21 <= value['instance'] <= 21+(65535-20049)//100"
if source.count(old) != 1:
    raise SystemExit('unexpected_runtime_instance_guard')
path.write_text(source.replace(old, new))
