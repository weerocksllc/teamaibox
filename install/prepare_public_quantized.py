#!/usr/bin/env python3
"""Quantize verified publisher weights with public synthetic calibration data.

Runs a GPU build container only. Does not stop any service or use user prompts.
Run when the GPU has enough free memory. A failed output is never install-ready.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
from offline_common import digest, need, read_json, run, write_json

ROOT = Path(__file__).resolve().parents[1]


def release_input_cache(paths):
    """Release only our verified input pages, never host-wide caches/data.

    GB10 shares CPU/GPU memory. Hashing large weights can fill the page cache;
    CUDA's immediately-free count then makes Accelerate incorrectly place the
    model on CPU despite reclaimable RAM. FADV_DONTNEED is an advisory cache
    eviction, not a file deletion or change to model contents.
    """
    if not hasattr(os, 'posix_fadvise'):
        return
    for path in paths:
        with path.open('rb') as stream:
            os.fsync(stream.fileno())
            os.posix_fadvise(stream.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)


def unified_memory_arguments(names, meminfo, weight_bytes):
    """Use a bounded single-GB10 budget instead of CUDA's free-page count.

    A model that fits shared RAM need not use Accelerate's CPU offload hooks
    and the separate streaming exporter. Reserve memory for calibration and
    the host; never stop workloads to satisfy the budget.
    """
    if len(names) != 1 or 'GB10' not in names[0]:
        return ['--use_seq_device_map', '--gpu_max_mem_percentage', '0.58']
    values={line.split(':')[0]:int(line.split()[1])*1024 for line in meminfo.splitlines()
            if line.startswith(('MemAvailable:', 'MemTotal:'))}
    available,total=values.get('MemAvailable',0),values.get('MemTotal',0)
    need(0<available<=total,'shared-memory capacity is unavailable')
    gpu=int(min(available*0.65,total*0.70))
    need(gpu>=weight_bytes*1.25,'insufficient available shared memory for GPU quantization; wait for other workloads to finish')
    gib=1024**3
    return ['--offload_folder','/tmp/modelopt-offload','--max_gpu_memory_gb',str(gpu/gib),
            '--max_cpu_memory_gb',str(max(gib,int(available*0.15))/gib)]

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--role', choices=('assistant','translation'), required=True)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--tools-image', required=True)
    a = p.parse_args()
    source, output = a.source.resolve(strict=True), a.output.absolute()
    need(not output.exists(), 'choose a new quantization output directory')
    inputs = read_json(source/'publisher-inputs.json')
    need(inputs.get('status') == 'publisher-files-verified', 'verify publisher model inputs first')
    # Recheck every source byte; a completion marker alone is not integrity.
    from fetch_public_models import identity
    for row in inputs['files']:
        need(identity(source/row['path'], dict(size=row['size'],blobId=row['gitBlob'],lfs=row['lfs'])),
             'publisher input changed: '+row['path'])
    release_input_cache(source/row['path'] for row in inputs['files'])
    names=run(['nvidia-smi','--query-gpu=name','--format=csv,noheader']).strip().splitlines()
    weight_bytes=sum(row['size'] for row in inputs['files'] if row['path'].endswith(('.safetensors','.bin')))
    memory_args=unified_memory_arguments(names,Path('/proc/meminfo').read_text(),weight_bytes)
    output.mkdir(parents=True)
    weights = output/'model'; weights.mkdir()
    recipe = ('huggingface/qwen3_5/ptq/w4a16_nvfp4-fp8_attn-kv_fp8_cast'
              if a.role == 'assistant' else '/recipe/lmt4-interior-mlp.yaml')
    tools_id = json.loads(run(['docker','image','inspect',a.tools_image]))[0]['Id']
    report = dict(status='building', role=a.role, source=inputs['repository'], revision=inputs['revision'],
                  toolsImageId=tools_id, recipe=recipe, calibration='NVIDIA ModelOpt synthetic_conversations_1k',
                  privateDataUsed=False, deployed=False, memoryArguments=memory_args)
    write_json(output/'build.json',report,0o644)
    command = ['docker','run','--rm','--network=none','--gpus','all','--ipc=private','--shm-size=8g',
        '--ulimit','memlock=-1','--ulimit','stack=67108864',
        '--user','0:0','--env','HF_HUB_OFFLINE=1','--env','TRANSFORMERS_OFFLINE=1',
        '--mount','type=bind,src='+str(source)+',dst=/source,readonly',
        '--mount','type=bind,src='+str(weights)+',dst=/output',
        '--mount','type=bind,src='+str(ROOT/'deploy/compute/qwen38-modelopt')+',dst=/recipe,readonly',
        '--entrypoint','python3',a.tools_image,'/opt/modelopt/examples/hf_ptq/hf_ptq.py',
        '--pyt_ckpt_path','/source','--recipe',recipe,
        '--dataset','/opt/modelopt/examples/dataset/synthetic_conversations_1k.jsonl',
        '--calib_size','128','--calib_seq','256','--batch_size','1','--skip_generate',
        *memory_args,'--export_path','/output']
    with (output/'build.log').open('xb') as log:
        result = subprocess.run(command,stdout=log,stderr=subprocess.STDOUT)
    try:
        need(result.returncode == 0,'quantization process failed; inspect build.log')
        # Preserve the exporter's weights/config and fill only missing publisher
        # notices/tokenizer resources. Original weight checksums are no longer
        # meaningful for the converted weights.
        for entry in inputs['files']:
            path = source/entry['path']
            if path.parent != source:
                continue
            if path.is_file() and path.suffix not in ('.safetensors','.bin') and path.name not in (
                    'publisher-inputs.json','model.safetensors.index.json','crc32.txt') and not (weights/path.name).exists():
                shutil.copyfile(path,weights/path.name)
        if a.role == 'translation':
            from fetch_public_models import translation_license
            translation_license(weights,source/'README.md')
        from artifact_validation import validate_asset
        from package import inventory_asset
        validate_asset(inventory_asset(weights,'assets/'+a.role+'-model',a.role+'-model'),weights)
        report['files'] = [{'path':p.name,'sha256':digest(p)} for p in sorted(weights.iterdir()) if p.is_file()]
        report['status'] = 'quantized'
    except Exception as error:
        report['status'] = 'failed'
        report['failure'] = str(error)
    write_json(output/'build.json',report,0o644)
    print(json.dumps(dict(status=report['status'],role=a.role)))
    raise SystemExit(report['status'] != 'quantized')
