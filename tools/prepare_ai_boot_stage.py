"""Package only changed AI readiness files and the already-built web assets."""
from pathlib import Path
import hashlib
import json
import shutil
import tempfile

root=Path(__file__).resolve().parents[1]
stage=Path(tempfile.mkdtemp(prefix='teamaibox-ai-boot-'))
api_files=['server/appliance-protected-office-runtime.mjs','src/applications/application-catalog-service.mjs',
           'src/applications/protected-office-catalog-repository.mjs']
for name in api_files:
    dest=stage/'payload/api'/name;dest.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(root/'apps/platform-api'/name,dest)
shutil.copytree(root/'apps/web/dist',stage/'payload/web')
for key in ['api','web']:
    shutil.copy2(root/('deploy/host/Dockerfile.ai-boot-'+key),stage/('Dockerfile.'+key))
    prefix='/opt/teamaibox/apps/platform-api/' if key=='api' else '/opt/teamaibox/phone-web/'
    base=stage/('payload/'+key)
    hashes={prefix+str(p.relative_to(base)):hashlib.sha256(p.read_bytes()).hexdigest() for p in base.rglob('*') if p.is_file()}
    (stage/('hashes.'+key+'.json')).write_text(json.dumps(hashes))
for name in ['deploy_ai_boot_recovery_20261023.py','deploy_product_copy_20261022.py','deploy_plugin_recovery_20261022.py',
             'restore_existing_office_workers.py','restore_calibrated_office_workers.py','restore_calibrated_office_workers_v2.py',
             'restore_calibrated_office_workers_v3.py','recover_ai_workers.py','ai_compilation_cache.py','ai_cache_checkpoint.py','boot_container_memory.py']:
    shutil.copy2(root/'tools'/name,stage/name)
shutil.copy2(root/'deploy/host/office-independent-recovery.conf',stage/'50-independent-recovery.conf')
shutil.copy2(root/'deploy/host/office-frontdoor-order.conf',stage/'40-frontdoor-order.conf')
shutil.copy2(root/'deploy/host/teamaibox-existing-office-workers.service',stage/'teamaibox-existing-office-workers.service')
print(stage)
