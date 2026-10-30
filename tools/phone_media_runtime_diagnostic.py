"""Read-only process/declaration checks inside an exact synthetic phone.

No screen, guest data, command arguments, keys, or grants are returned.
"""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, '/opt/teamaibox')
from phone_runtime import CONFIG, closed_json
from phone_media_control import MediaError, Streamer

expected=json.loads(sys.stdin.read())
config=closed_json(CONFIG.read_bytes())
result={'bindingMatches': all(config[k]==expected[k] for k in ('phoneId','ownerId','runId','generation')), 'unreadableExecutables':0}
streamer=Streamer()
try:
    value=streamer.current()
    result['streamerFound']=True
except Exception as e:
    result['streamerFound']=False
    result['errorCode']=str(e) if isinstance(e,MediaError) else type(e).__name__
for entry in Path('/proc').iterdir():
    if not entry.name.isdecimal():continue
    try:os.readlink(entry/'exe')
    except PermissionError:result['unreadableExecutables']+=1
    except (FileNotFoundError,ProcessLookupError):pass
print(json.dumps(result))
