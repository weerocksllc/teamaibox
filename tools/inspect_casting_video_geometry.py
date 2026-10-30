#!/usr/bin/env python3
"""Read only numeric health for one explicitly identified casting session."""
import argparse
import json
from uuid import UUID
from deploy_casting_start_fix import remote


def inspect(session_id):
    session_id = str(UUID(session_id))
    js = """import {createTrustedMediaRuntimeFromEnvironment} from '/opt/teamaibox/apps/platform-api/server/trusted-media-runtime.mjs';
const c=await createTrustedMediaRuntimeFromEnvironment(process.env);
try {
 const h=await c.health({sessionId:SESSION});
 console.log(JSON.stringify({healthy:h.healthy,progress:h.progress??null}));
} finally {c.close();}
""".replace('SESSION', json.dumps(session_id))
    code = "p=r.subprocess.run(['docker','exec',r.PLATFORM,'node','--input-type=module','-e',"+repr(js)+"],capture_output=True,timeout=20)\nassert p.returncode==0\nprint(json.dumps(json.loads(p.stdout)))"
    return remote(code, 30)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session-id', required=True)
    args = parser.parse_args()
    print(json.dumps(inspect(args.session_id)))
