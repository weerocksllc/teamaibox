#!/usr/bin/env python3
"""Test distro tmpfiles semantics in a new isolated synthetic root only."""
import json
from pathlib import Path
import subprocess
import tempfile

variants = [('age-exclusion-only','x /tmp/keep - - - -',[]),
            ('explicit-child-directory','d /tmp/keep 0700 0 0 -',[]),
            ('command-prefix','x /tmp/keep - - - -',['--exclude-prefix=/tmp/keep']),
            ('age-only-parent','x /tmp/keep - - - -',[])]
for name,rule,args in variants:
    with tempfile.TemporaryDirectory(prefix='teamaibox-tmpfiles-canary-') as directory:
        root = Path(directory)
        (root/'tmp/keep').mkdir(parents=True)
        (root/'tmp/keep/canary').write_text('synthetic')
        (root/'tmp/remove-canary').write_text('synthetic')
        config = root/'test.conf'
        parent_type='d' if name=='age-only-parent' else 'D'
        config.write_text(parent_type+' /tmp 1777 0 0 30d\n'+rule+'\n')
        result = subprocess.run(['systemd-tmpfiles','--root='+directory,'--remove','--boot',*args,str(config)],
                                capture_output=True, text=True, timeout=30)
        facts = {'variant':name,'exitCode':result.returncode,'excludedContentPreserved':(root/'tmp/keep/canary').exists(),
                 'ordinarySyntheticFileRemoved':not (root/'tmp/remove-canary').exists(),
                 'realTmpTouched':False}
        print(json.dumps(facts))
        if name=='age-only-parent':
            assert result.returncode==0 and facts['excludedContentPreserved']
