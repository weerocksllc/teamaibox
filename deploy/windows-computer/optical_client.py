"""Fixed Agent side command. Never accepts program names or host file paths."""
import json
from pathlib import Path
import sys
from runtime import validate_config, optical_command

def execute():
    raw=sys.stdin.read(4097)
    if len(raw)>4096:
        raise ValueError('computer_media_request_invalid')
    config=validate_config(json.loads(Path('/run/computer/config.json').read_text()))
    try:
        result=optical_command(config,Path('/guest'),Path('/control'),'optical-change',json.loads(raw))
        print(json.dumps(result))
    except RuntimeError as error:
        # Only a locked pre-change drive is a proven no-effect rejection.
        # Other errors/lost replies remain uncertain for the same operation.
        if str(error)!='computer_media_locked': raise
        print(json.dumps({'errorCode':'computer_optical_locked'}))

if __name__=='__main__':execute()
