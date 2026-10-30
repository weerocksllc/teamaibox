#!/usr/bin/env python3
"""One resumable public-source build and fresh install. Never clears a host."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
from offline_common import digest, need, read_json, run, write_json

ROOT = Path(__file__).resolve().parents[1]
GUACAMOLE = 'docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40'
GUACD = 'docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f'


def source_identity(root):
    files = subprocess.check_output(['git','-C',str(root),'ls-files','-z','--cached','--others','--exclude-standard'])
    h = hashlib.sha256()
    for name in sorted(set(files.split(b'\0')) - {b''}):
        path=root/os.fsdecode(name)
        need(path.is_file() and not path.is_symlink(), 'missing or linked source input: '+os.fsdecode(name))
        h.update(name+b'\0'+bytes.fromhex(digest(path)))
    return h.hexdigest()


def tree_inventory(path):
    files={}
    for file in sorted(path.rglob('*')):
        if file.is_symlink():
            # Record links without traversing them (SDK and package trees can
            # contain library links). Consumers still validate their inputs.
            files[file.relative_to(path).as_posix()]={'symlink':os.readlink(file)}
        elif file.is_file():
            files[file.relative_to(path).as_posix()]=digest(file)
    return files


class Pipeline:
    def __init__(self, work, identity, target):
        self.work=work
        need(not any(p.is_symlink() for p in (work,*work.parents)), 'workspace cannot contain symlinks')
        work.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.lock=(work/'build.lock').open('a')
        try:
            fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise RuntimeError('another source build is using this workspace')
        self.file=work/'state.json'
        self.state=read_json(self.file) if self.file.exists() else dict(
            schemaVersion=1,sourceIdentity=identity,target=str(target),stages={})
        if self.state['sourceIdentity']!=identity or self.state['target']!=str(target):
            self.lock.close()
            raise RuntimeError('source or installation target changed; use a new workspace and retain the download cache')
        write_json(self.file,self.state)

    def step(self,name,action,images=False):
        prior=self.state['stages'].get(name,{})
        if prior.get('status')=='complete':
            path=Path(prior['output'])
            need(tree_inventory(path)==prior['files'], 'completed output changed: '+name)
            for image in prior.get('images',[]):
                actual=json.loads(run(['docker','image','inspect',image]))[0]
                need(actual['Id']==image and actual['Architecture']=='arm64', 'cached image changed: '+name)
            print('[reuse] '+name,flush=True)
            return path
        attempt=prior.get('attempt',0)+1
        output=self.work/'stages'/name/str(attempt)
        output.parent.mkdir(parents=True,exist_ok=True)
        self.state['current']=name
        self.state['stages'][name]=dict(status='running',attempt=attempt,output=str(output))
        write_json(self.file,self.state)
        print('[start] '+name+' → '+str(output),flush=True)
        try:
            action(output)
            ids=[]
            if images:
                report=read_json(output/'images.json')
                need(report.get('status') in ('selected-images-built','runtime-built'), 'image stage failed: '+name)
                ids=list(report['images'].values())
            self.state['stages'][name].update(status='complete',files=tree_inventory(output),images=ids)
            write_json(self.file,self.state)
            print('[done] '+name,flush=True)
            return output
        except BaseException as error:
            self.state['stages'][name].update(status='failed',error=str(error))
            write_json(self.file,self.state)
            raise

    def command(self,args,log):
        log.parent.mkdir(parents=True,exist_ok=True)
        with log.open('ab') as stream:
            subprocess.run(list(map(str,args)),cwd=ROOT,check=True,stdout=stream,stderr=subprocess.STDOUT)

    def script(self,name,script,args,marker=None,status=None,images=False):
        def action(out):
            self.command([sys.executable,ROOT/script,*args,'--output',out],out.parent/(out.name+'.log'))
            if marker and status:
                need(read_json(out/marker).get('status') in status, name+' did not complete')
        return self.step(name,action,images)


def configure_network(work,region,model_endpoint,registry_mirror):
    from public_model_git import endpoint
    # Never reuse credentials or proxy settings from the developer's shell.
    for name in list(os.environ):
        if name.lower() in ('http_proxy','https_proxy','all_proxy','no_proxy'):
            del os.environ[name]
    real=shutil.which('docker'); need(real is not None,'Docker must already be installed')
    network=work/'network';network.mkdir(exist_ok=True)
    config=network/'docker';config.mkdir(exist_ok=True)
    write_json(config/'config.json',{})
    os.environ['DOCKER_CONFIG']=str(config)
    selected=registry_mirror or ('https://docker.m.daocloud.io' if region=='cn' else None)
    origin=endpoint(model_endpoint or ('https://hf-mirror.com' if region=='cn' else 'https://huggingface.co'))
    os.environ['TEAMAIBOX_MODEL_ENDPOINT']=origin
    if selected:
        selected=endpoint(selected)
        os.environ['TEAMAIBOX_REGISTRY_MIRROR']=selected
    else:
        os.environ.pop('TEAMAIBOX_REGISTRY_MIRROR',None)
    wrapper=network/'bin';wrapper.mkdir(exist_ok=True)
    # Runtime-generated wrapper, never a global docker executable change.
    (wrapper/'docker').write_text('#!'+sys.executable+'\nimport runpy,sys\nsys.path.insert(0,'+
        repr(str(ROOT/'install'))+')\nrunpy.run_path('+repr(str(ROOT/'install/source_network.py'))+',run_name="__main__")\n')
    (wrapper/'docker').chmod(0o755)
    os.environ.update(TEAMAIBOX_REAL_DOCKER=real,TEAMAIBOX_NETWORK_WORK=str(network),
                      PATH=str(wrapper)+':'+os.environ['PATH'])
    return origin


def models(p,cache,origin):
    from fetch_public_models import fetch, identity, PROFILES
    results={}
    for role in PROFILES:
        output=cache/'assets'/role
        profile=read_json(ROOT/'deploy/compute'/PROFILES[role])['source']
        if (output/'publisher-inputs.json').exists():
            report=read_json(output/'publisher-inputs.json')
            need(report['repository']==profile['model'] and report['revision']==profile['revision'],
                 'model cache belongs to another revision: '+role)
            if report['status']=='publisher-files-verified':
                # Recheck against publisher/pinned-Git metadata, not hashes an
                # imported cache could have invented in its own report.
                print('[verify cache] model '+role,flush=True)
        print('[download] '+role+' from '+origin,flush=True)
        official = origin == 'https://huggingface.co'
        fetch(role,output,resume=output.exists(),transfer='ranges',range_workers=4 if official else 1,
              endpoint=origin,file_workers=2 if official else 1)
        results[role]=output
    return results


def build(p,cache,origin):
    from source_toolchain import prepare,UBUNTU
    from build_public_services import RECIPES,ALIASES,UPSTREAM_IMAGES,NODE_SERVICES
    tool=p.step('toolchain',lambda out:prepare(out,cache,lambda args:p.command(args,p.work/'toolchain.log')))
    tools=read_json(tool/'tools.json')
    os.environ['PATH']=tools['go']+':'+os.environ['PATH']
    assets=models(p,cache,origin)
    os.environ['TEAMAIBOX_ASR_MODEL']=str(assets['asr-model'])
    # One stage per image: successful roles survive failures in other roles.
    reports=[];references={};image_map={}
    roles=['platform-api',*sorted(set(RECIPES)-{'platform-api'})]
    for role in [*roles,*sorted(UPSTREAM_IMAGES),'desktop-proxy']:
        args=['--roles',role,'--network','host','--guacamole-image',GUACAMOLE,'--guacd-image',GUACD]
        out=p.script('image-'+role,'install/build_public_services.py',args,images=True)
        report=read_json(out/'images.json')
        # Node helper reports may repeat the API dependency; select exactly the
        # requested role, rather than merging contradictory auxiliary outputs.
        image_map[role]=report['images'][role];references[role]=report['references'][role]
    for role,parent in ALIASES.items():
        image_map[role]=image_map[parent];references[role]=references[parent]
    sfu=p.script('sfu','install/build_public_sfu.py',['--cache',cache/'downloads'],images=True)
    image_map.update(read_json(sfu/'images.json')['images'])
    android=p.script('android','install/build_public_android.py',['--cache',cache/'android-downloads'],
                     'build.json',('base-runtime-built',))
    base=read_json(android/'build.json')['images']['network']['reference']
    def docker_tool(name,dockerfile,arguments,context):
        tag='teamaibox-source-tools:'+p.state['sourceIdentity'][:16]+'-'+name
        def action(out):
            out.mkdir()
            p.command(['docker','build','--network=host',*arguments,'-f',ROOT/dockerfile,'-t',tag,ROOT/context],out/'build.log')
            actual=json.loads(run(['docker','image','inspect',tag]))[0]
            write_json(out/'images.json',dict(status='selected-images-built',images={name:actual['Id']},references={name:tag}))
        out=p.step(name,action,images=True)
        return read_json(out/'images.json')['references'][name]
    phone_tools=docker_tool('phone-tools','deploy/android/cuttlefish/GappsTools.Dockerfile',
        ['--build-arg','PHONE_BASE_IMAGE='+base],'deploy/android/cuttlefish')
    backend=p.script('camera-backend','install/build_public_camera_backend.py',['--cache',cache/'camera-downloads'],
                     'build.json',('backend-built',))
    kernel=p.script('camera-kernel','install/fetch_public_camera_kernel.py',[])
    guest=p.script('camera-guest-source','tools/prepare_phone_camera_guest_driver.py',[])
    driver=p.script('camera-driver','tools/build_phone_camera_guest_driver.py',[
        '--inputs',kernel,'--source',guest,'--compiler-image',read_json(backend/'build.json')['compiler']])
    def stock(out):
        out.mkdir()
        p.command(['docker','run','--rm','--network=none','--read-only','--user','0:0','--tmpfs','/tmp:size=2g',
            '--entrypoint','python3','--mount','type=bind,src='+str(ROOT/'deploy/android/cuttlefish')+',dst=/build,readonly',
            '--mount','type=bind,src='+str(out)+',dst=/work',phone_tools,'/build/prepare_camera_rom_inputs.py'],out/'extract.log')
    stock_dir=p.step('stock-camera',stock)
    apk=p.script('camera-apk','install/build_public_camera_apk.py',['--stock',stock_dir/'inputs/stock-Camera2.apk',
        '--sdk',tools['sdk'],'--java-home',tools['java'],'--zipalign',tools['zipalign']], 'camera-preview.json',('built',))
    rom=p.script('camera-rom','install/build_public_phone_rom.py',['--base-image',base,'--tools-image',phone_tools,
        '--apk',apk,'--module',driver])
    phone=p.script('phone','install/build_public_phone_runtime.py',[
        '--base-image',read_json(rom/'build.json')['reference'],'--backend',backend,'--cache',cache/'camera-downloads'],images=True)
    phone_report=read_json(phone/'images.json');image_map.update(phone_report['images'])
    google_tools=docker_tool('google-tools','deploy/android/cuttlefish/GappsTools.Dockerfile',[
        '--build-arg','PHONE_BASE_IMAGE='+phone_report['references']['phone-runtime']],'deploy/android/cuttlefish')
    inspection=p.script('google-inputs','install/inspect_public_phone_inputs.py',[
        '--tools-image',google_tools,'--cache',cache/'google-downloads'])
    google=p.script('google-phone','install/build_public_google_phone.py',[
        '--base-image',phone_report['references']['phone-runtime'],'--tools-image',google_tools,'--inspection',inspection],images=True)
    image_map.update(read_json(google/'images.json')['images'])
    from offline_common import IMAGE_ROLES
    need(set(image_map)==IMAGE_ROLES,'factory image role closure incomplete')
    images=p.work/'images.json';write_json(images,dict(images=image_map))
    modelopt=docker_tool('modelopt','deploy/compute/qwen38-modelopt/Dockerfile',[
        '--build-arg','OFFICE_ENGINE_IMAGE='+references['assistant-worker']],'deploy/compute/qwen38-modelopt')
    for role in ('translation','assistant'):
        out=p.script('quantize-'+role,'install/prepare_public_quantized.py',[
            '--role',role,'--source',assets[role+'-source'],'--tools-image',modelopt],'build.json',('quantized',))
        assets[role+'-model']=out/'model'
    resources=p.script('resources','install/prepare_public_resources.py',[
        '--images',images,'--driver-cache',cache/'downloads/virtio-win-0.1.285.iso'])
    guest_tools=p.script('guest-tools','install/build_guest_tools.py',[])
    p.command(['docker','pull','--platform=linux/arm64',UBUNTU],p.work/'ubuntu.log')
    ubuntu=json.loads(run(['docker','image','inspect',UBUNTU]))[0]['Id']
    packages=p.script('host-packages','install/collect_host_packages.py',[
        '--base-image',ubuntu,'--network','host'],'collection.json',('collected',))
    config_assets=read_json(resources/'assets.json')
    for role in ('assistant-model','translation-model','embedding-model','drawing-model','ocr-model','asr-model'):
        config_assets[role]=dict(source=str(assets[role]),destination='assets/'+role)
    config_assets['guest-host-tools']=dict(source=str(guest_tools),destination='assets/guest-host-tools')
    commit=run(['git','rev-parse','HEAD']).strip()
    release_id='source-'+commit[:12]+'-'+p.state['sourceIdentity'][:12]
    inputs=p.work/'inputs.json'
    write_json(inputs,dict(schemaVersion=1,releaseId=release_id,sourceCommit=commit,agentVersion='1.0.0',
        images=image_map,assets=config_assets,hostPackageCollection=str(packages/'collection.json'),
        guestSystems=dict(androidVersion='17',androidBaseBuildId='16102939',cameraSources=['image','browser','video','usb','udp']),
        freeReserveBytes=16*1024**3))
    release=p.script('release','install/prepare-release.py',['--inputs',inputs])
    args=['--release',release/'release-input.json']
    if run(['git','status','--porcelain']).strip():
        args.append('--allow-working-tree')
    package=p.script('package','install/package.py',args)
    return package/('teamaibox-'+release_id+'-linux-arm64')


def protect_existing_install(target, state):
    if target.exists() and any(target.iterdir()):
        need(state.get('package') and (target/'install-state.json').is_file(),
             'existing installation preserved; use its upgrade flow, not a fresh source install')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir',type=Path,default=Path('/var/tmp/teamaibox-source-build'))
    parser.add_argument('--cache-dir',type=Path,help='persistent public download cache outside checkout')
    parser.add_argument('--installation-root',type=Path,default=Path('/srv/teamaibox/installation'))
    parser.add_argument('--region',choices=('global','cn'),default='global')
    parser.add_argument('--model-endpoint');parser.add_argument('--registry-mirror')
    parser.add_argument('--build-only',action='store_true')
    parser.add_argument('--download-models-only',action='store_true')
    parser.add_argument('--check',action='store_true',help='read-only host/source preflight; no downloads')
    a=parser.parse_args()
    need(platform.system()=='Linux' and platform.machine() in ('aarch64','arm64'),'requires Linux ARM64 DGX Spark')
    need(os.geteuid()==0,'run sudo bash install/from-source.sh (host tools and final installation require root)')
    # A sudo invocation can safely read the explicit caller-owned public clone
    # without editing root's global Git settings or trusting every directory.
    os.environ.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull,
                      GIT_CONFIG_COUNT='1',GIT_CONFIG_KEY_0='safe.directory',GIT_CONFIG_VALUE_0=str(ROOT),
                      NEEDRESTART_MODE='l',DEBIAN_FRONTEND='noninteractive')
    need(Path('/etc/os-release').read_text().find('VERSION_ID="24.04"')>=0,'requires Ubuntu 24.04')
    for tool in ('docker','git','nvidia-smi','dpkg-query'):
        need(shutil.which(tool), 'existing foundation tool missing: '+tool)
    need(Path('/dev/kvm').exists(),'KVM unavailable')
    run(['docker','info']);run(['nvidia-smi','-L'])
    work=a.work_dir.absolute();cache=(a.cache_dir or work/'cache').absolute();target=a.installation_root.absolute()
    for path in (work,cache,target):
        need(not path.resolve().is_relative_to(ROOT) and path != Path('/') and
             not any(p.is_symlink() for p in (path,*path.parents)), 'unsafe build/cache/install path')
    identity=source_identity(ROOT)
    if a.check:
        print(json.dumps(dict(status='preflight-passed',sourceIdentity=identity,
            installed=False,networkDownloadsVerified=False)));return
    p=Pipeline(work,identity,target)
    try:
        if not a.build_only and not a.download_models_only:
            protect_existing_install(target,p.state)
        cache.mkdir(parents=True,exist_ok=True)
        origin=configure_network(work,a.region,a.model_endpoint,a.registry_mirror)
        if a.download_models_only:
            models(p,cache,origin);print('Model downloads verified; NOT built or installed.');return
        bundle=build(p,cache,origin)
        p.state['package']=str(bundle);write_json(p.file,p.state)
        if a.build_only:
            print('Package ready; NOT installed: '+str(bundle));return
        # The existing installer owns data protection, its lock and resume.
        subprocess.run(['bash',str(bundle/'install.sh'),'--installation-root',str(target)],check=True)
        p.state['installed']=True;write_json(p.file,p.state)
        print('Installation completed. See '+str(target/'readiness.json'))
    finally:
        p.lock.close()


if __name__=='__main__':
    try:
        main()
    except (Exception,KeyboardInterrupt) as error:
        print('Source installation stopped: '+str(error)+
              '\nKeep the workspace and cache. Resolve this stage, then rerun the same command. No data was reset.',file=sys.stderr)
        raise SystemExit(1)
