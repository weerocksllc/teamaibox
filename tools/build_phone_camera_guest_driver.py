#!/usr/bin/env python3
"""Build the pinned guest module offline. Never starts or modifies a phone."""
import argparse,hashlib,io,json,os,re,shutil,subprocess,tarfile
from pathlib import Path
from phone_camera_guest_driver_patch import adapt,COMMIT

ROOT=Path(__file__).resolve().parents[1]
RELEASE='6.12.74-android16-6-g3ec022196c4e-ab15076761-4k'
sha=lambda b:hashlib.sha256(b).hexdigest()

def unpack(archive,destination,skip=()):
    destination.mkdir(parents=True,exist_ok=True)
    for member in archive.getmembers():
        p=Path(member.name)
        if p.is_absolute() or '..' in p.parts:raise RuntimeError('archive_path_invalid')
        if str(p) in skip or member.issym() or member.islnk():continue
        if not member.isfile() and not member.isdir():raise RuntimeError('archive_entry_invalid')
        archive.extract(member,destination)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--inputs',type=Path,required=True)
    p.add_argument('--source',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--compiler-image',required=True);a=p.parse_args()
    import uuid
    rid='teamaibox-guest-build-'+uuid.uuid4().hex
    INPUT=a.inputs.resolve();SOURCE=a.source.resolve()
    stage=a.output.absolute();out=stage/'build.json'
    if stage.exists() or out.exists():raise RuntimeError('run_occupied')
    lock=json.loads((INPUT/'inputs.json').read_bytes());sources=json.loads((SOURCE/'source.json').read_bytes())
    for item in lock['artifacts']:
        if sha((INPUT/item['name']).read_bytes())!=item['sha256']:raise RuntimeError('input_changed')
    if sources['commit']!=COMMIT:raise RuntimeError('driver_revision_changed')
    image=json.loads(subprocess.check_output(['docker','image','inspect',a.compiler_image]))[0]
    if image['Architecture']!='arm64':raise RuntimeError('compiler_architecture_changed')
    stage.mkdir(parents=True);kernel=stage/'kernel';kernel.mkdir();build=stage/'out';build.mkdir()
    r=dict(runId=rid,status='failed',guestStarted=False,published=False,compilerImage=image['Id'],
        kernelInputsSha256=sha((INPUT/'inputs.json').read_bytes()),upstreamCommit=COMMIT,
        sources={str(f.relative_to(ROOT)):sha(f.read_bytes()) for f in
                 (Path(__file__),ROOT/'tools/phone_camera_guest_driver_patch.py',ROOT/'deploy/android/cuttlefish/PublicCameraCompiler.Dockerfile',ROOT/'tools/phone_camera_guest_module_build.sh')})
    try:
        with tarfile.open(INPUT/'kernel_aarch64_ddk_headers_archive.tar.gz') as tar:unpack(tar,kernel)
        with tarfile.open(INPUT/'kernel_aarch64_filegroup_decl.tar.gz') as tar:
            prefix='bazel-out/k8-fastbuild/bin/common/'
            for name,dest,skip in (
                (prefix+'kernel_aarch64/kernel_aarch64_module_env.tar.gz',kernel,()),
                (prefix+'kernel_aarch64_modules_prepare/modules_prepare_outdir.tar.gz',build,('Makefile',))):
                with tarfile.open(fileobj=io.BytesIO(tar.extractfile(name).read())) as nested:unpack(nested,dest,skip)
        shutil.copyfile(INPUT/'kernel_aarch64_Module.symvers',build/'Module.symvers')
        shutil.copyfile(INPUT/'kernel_aarch64_dot_config',build/'.config')
        # The upstream preparation archive contains read-only x86 host tools.
        # Make only this isolated build output writable for their ARM rebuild;
        # the downloaded archives and kernel source remain unchanged.
        import stat
        for path in (build, *build.rglob('*')):
            if path.is_dir() and not path.is_symlink():
                path.chmod(stat.S_IMODE(path.stat().st_mode) | stat.S_IWUSR)
        for relative in ('scripts/basic/fixdep', 'scripts/mod/modpost'):
            path=build/relative
            if path.is_file():path.chmod(stat.S_IMODE(path.stat().st_mode) | stat.S_IWUSR)
        (build/'source').symlink_to('../kernel/common')
        for name,digest in sources['upstream'].items():
            raw=(SOURCE/'upstream'/name).read_bytes()
            if sha(raw)!=digest:raise RuntimeError('driver_source_changed')
            dest=stage/'driver'/name;dest.parent.mkdir(exist_ok=True)
            dest.write_bytes(adapt(raw.decode()).encode() if name=='virtio_media_driver.c' else raw)
        shutil.copyfile(ROOT/'tools/phone_camera_guest_module_build.sh',stage/'build.sh')
        command=['docker','run','--rm','--name',rid,'--network=none','--read-only','--memory=2g','--memory-swap=2g',
            '--user',str(os.getuid())+':'+str(os.getgid()),
            '--cpus=2','--pids-limit=128','--cap-drop=ALL','--security-opt=no-new-privileges','--tmpfs=/tmp:size=256m',
            '--mount','type=bind,src='+str(stage)+',dst=/work','--workdir=/work',image['Id'],
            'sh','/work/build.sh','make','-C','kernel/common','O=/work/out','M=/work/driver','ARCH=arm64',
            'KERNELRELEASE='+RELEASE,'-j2','modules']
        command+=['LLVM=1','HOSTCC=clang','HOSTCXX=clang++']
        result=subprocess.run(command,capture_output=True,timeout=360)
        r['buildExitCode']=result.returncode;r['buildOutput']=(result.stdout+result.stderr).decode(errors='replace')[-16000:]
        if result.returncode:raise RuntimeError('module_build_failed')
        module=stage/'driver/virtio-media.ko';raw=module.read_bytes()
        if raw[:6]!=b'\x7fELF\x02\x01' or raw[18:20]!=b'\xb7\x00':raise RuntimeError('module_architecture_invalid')
        if b'vermagic='+RELEASE.encode()+b' ' not in raw:raise RuntimeError('module_kernel_mismatch')
        r.update(status='passed',moduleSha256=sha(raw),moduleBytes=len(raw),module=str(module))
    except Exception as error:r['failure']=str(error)[:500]
    finally:
        found=subprocess.run(['docker','inspect',rid],capture_output=True,timeout=15)
        if found.returncode==0:
            item=json.loads(found.stdout)[0]
            if item['Image']!=image['Id'] or not any(m.get('Source')==str(stage) for m in item['Mounts']):
                raise RuntimeError('build_cleanup_identity_changed')
            subprocess.run(['docker','rm','-f',item['Id']],check=True,capture_output=True,timeout=20)
        r['containerRemoved']=True
    with out.open('x') as f:json.dump(r,f,indent=2);f.write('\n')
    print(json.dumps(r));return r['status']!='passed'

if __name__=='__main__':raise SystemExit(main())
