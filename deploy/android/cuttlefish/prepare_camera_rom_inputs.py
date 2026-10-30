#!/usr/bin/env python3
"""Extract only immutable AOSP build inputs in a new build workspace."""
import json
from pathlib import Path
import shutil
from gapps_image import extract
from gapps_inspect import command, sha

work=Path('/work'); base=Path('/opt/cuttlefish')
parts=work/'partitions'; parts.mkdir()
extract(base/'super.img',parts,['product_a','system_a','system_ext_a','vendor_a'])
for name in ('product','system','system_ext','vendor'):
    command(['fsck.erofs','--extract='+str(work/name),'--no-preserve-owner',parts/(name+'_a.img')])
inputs=work/'inputs'; inputs.mkdir()
contexts=[]
for index,path in enumerate(sorted(work.rglob('*file_contexts'))):
    if path.is_file() and not path.is_symlink():
        name='file_contexts_'+str(index)
        shutil.copyfile(path,inputs/name); contexts.append(name)
assert contexts, 'SELinux contexts missing from source ROM'
(inputs/'contexts.json').write_text(json.dumps(contexts))
stock=work/'product/app/Camera2/Camera2.apk'
assert sha(stock)=='5888fe9106b4cd2d47a52a65f209e9464f77793b4477ff036c3797fdf44191d1'
shutil.copyfile(stock,inputs/'stock-Camera2.apk')
print(json.dumps({'stockSha256':sha(stock),'contextFiles':len(contexts),'privateDataUsed':False}))
