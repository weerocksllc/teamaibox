"""Integrated design stages for the standard public-source installer.

All inputs are public, fixed sources; no live container or data volume is read.
The pipeline owns checkpoints. Builders own their own content-addressed caches.
"""
import json
from pathlib import Path
import re
import shutil
import subprocess
import uuid

from offline_common import need, read_json, run, write_json
from artifact_validation import validate_asset
from build_penpot_agent import build as build_agent, inspect
from build_penpot_native import build as build_native
from build_penpot_stack import build as build_stack, ROLES, safe_output
from factory_penpot import PENPOT_IMAGE_ROLES
from package_penpot_sources import package as package_sources

ROOT = Path(__file__).resolve().parents[1]


def dependency(reference):
    need(re.fullmatch(r'docker.io/[a-z0-9/-]+@sha256:[a-f0-9]{64}', reference), 'unpinned design dependency')
    image = inspect(reference)
    if image is None:
        subprocess.run(['docker', 'pull', '--platform=linux/arm64', reference], check=True)
        image = inspect(reference)
    need(image and image['Os'] == 'linux' and image['Architecture'] == 'arm64', 'design dependency architecture mismatch')
    need(any(value.endswith('@'+reference.split('@')[1]) for value in image.get('RepoDigests', [])),
         'design dependency digest mismatch')
    return image['Id']


def plugin_asset(image, destination):
    """Copy only immutable official plugin distribution from an unstarted image."""
    need(re.fullmatch(r'sha256:[a-f0-9]{64}', image), 'plugin image ID required')
    destination = safe_output(destination)
    need(not destination.exists(), 'plugin asset output already exists')
    destination.mkdir(parents=True)
    label = 'penpot-release-export-' + uuid.uuid4().hex
    container = run(['docker','create','--network=none','--label','com.teamaibox.export='+label,
                     '--entrypoint','/bin/true',image]).strip()
    try:
        need(re.fullmatch(r'[a-f0-9]{64}',container), 'invalid export container identity')
        # Never start the container, mount user data, or export its whole FS.
        run(['docker','cp',container+':/opt/penpot/mcp/packages/plugin/dist/.',str(destination)])
        run(['docker','cp',container+':/opt/penpot/mcp/LICENSE.penpot',str(destination/'LICENSE')])
        files=[]
        for file in destination.rglob('*'):
            need(not file.is_symlink(), 'linked plugin artifact rejected')
            if file.is_file():
                files.append(dict(path=file.relative_to(destination).as_posix(),size=file.stat().st_size))
        validate_asset(dict(role='penpot-plugin',files=files), destination)
    finally:
        if re.fullmatch(r'[a-f0-9]{64}',container):
            actual=json.loads(run(['docker','container','inspect',container]))[0]
            if (actual['Id']==container and actual['Image']==image and not actual['State']['Running']
                and actual['Config']['Labels'].get('com.teamaibox.export')==label):
                run(['docker','container','rm',container])


def assemble(pipeline, cache, agent_base):
    cache = safe_output(cache)
    def action(output):
        output.mkdir(parents=True)
        native = build_native(cache/'native')
        stack = build_stack(cache/'downloads',cache/'stack',list(ROLES))
        agent = build_agent(agent_base,Path(native['artifact']),native['binarySha256'],cache/'agent')
        images = dict(stack['images'])
        lock = read_json(ROOT/'deploy/penpot-runtime-dependencies.lock.json')
        need(lock['platform']=='linux/arm64' and set(lock['images'])=={'penpot-postgres','penpot-cache'},
             'design dependency declaration incomplete')
        for role, reference in lock['images'].items():
            images[role] = dependency(reference)
        need(set(images)==PENPOT_IMAGE_ROLES, 'design image role closure incomplete')
        images['agent-sandbox'] = agent['imageId']
        plugin_asset(images['penpot-mcp'],output/'plugin')
        corresponding = output/'corresponding-source'
        corresponding.mkdir()
        package_sources(cache/'downloads',corresponding/'source.tar.gz',Path(native['original']))
        shutil.copyfile(ROOT/'LICENSES/MPL-2.0.txt',corresponding/'LICENSE')
        write_json(output/'images.json',dict(status='selected-images-built',images=images,
            references=images,modifiedByPlatform=True,nativeBinarySha256=native['binarySha256']))
    output = pipeline.step('penpot',action,images=True)
    report = read_json(output/'images.json')
    return report['images'], {
        'penpot-plugin':dict(source=str(output/'plugin'),destination='assets/penpot-plugin'),
        'penpot-corresponding-source':dict(source=str(output/'corresponding-source'),destination='assets/penpot-corresponding-source'),
    }
