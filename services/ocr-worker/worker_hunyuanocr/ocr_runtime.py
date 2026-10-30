"""MIT-licensed local adapter for the public HunyuanOCR/vLLM interfaces.

The package name preserves the managed engine's import contract. This module
contains no account, billing, object-store or remote worker registration code.
Models are supplied by the offline package, not downloaded at runtime.
"""
from dataclasses import dataclass
from importlib.metadata import version
import os
from pathlib import Path
import threading


@dataclass
class OCRRuntime:
    model: object
    processor: object
    inference_mode: str = 'vllm-dflash'
    backend_version: str = ''


_runtime = None
_lock = threading.Lock()


def model_options(environment):
    if environment.get('INFERENCE_MODE') != 'vllm-dflash':
        raise RuntimeError('the managed OCR adapter requires vllm-dflash')
    if environment.get('MODEL_LOCAL_FILES_ONLY', 'true').lower() != 'true':
        raise RuntimeError('runtime model downloads are not permitted')
    draft = Path(environment['DFLASH_MODEL_PATH'])
    if not (draft / 'config.json').is_file():
        raise RuntimeError('the offline DFlash model is missing')
    width = int(environment.get('DFLASH_NUM_SPECULATIVE_TOKENS', '15'))
    if width != 15:
        raise RuntimeError('unexpected DFlash speculation width')
    return dict(model=environment['MODEL_NAME'], revision=environment['MODEL_REVISION'],
                trust_remote_code=True, tensor_parallel_size=1,
                dtype=environment.get('TORCH_DTYPE', 'bfloat16'),
                gpu_memory_utilization=float(environment.get('VLLM_GPU_MEMORY_UTILIZATION', '0.06')),
                max_model_len=int(environment.get('VLLM_MAX_MODEL_LEN', '8192')),
                kv_cache_memory_bytes=1342177280, max_num_seqs=1,
                max_num_batched_tokens=int(environment.get('VLLM_MAX_NUM_BATCHED_TOKENS', '8192')),
                spec_method='dflash', spec_model=str(draft), spec_tokens=width)


def get_runtime():
    global _runtime
    with _lock:
        if _runtime is not None:
            return _runtime
        options = model_options(os.environ)
        # These names configure this adapter, not vLLM's environment parser.
        for key in ('VLLM_GPU_MEMORY_UTILIZATION', 'VLLM_MAX_MODEL_LEN',
                    'VLLM_MAX_NUM_BATCHED_TOKENS', 'VLLM_TASK_CONCURRENCY', 'VLLM_BATCH_WAIT_MILLISECONDS'):
            os.environ.pop(key, None)
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        from transformers import AutoProcessor
        from vllm import LLM
        processor = AutoProcessor.from_pretrained(options['model'], revision=options['revision'],
                                                 use_fast=False, local_files_only=True, trust_remote_code=True)
        _runtime = OCRRuntime(LLM(**options), processor, backend_version=version('vllm'))
        return _runtime


def clean_repeated_substrings(text):
    # Preserve the existing long-output cleanup contract.
    if len(text) >= 8000:
        for width in range(2, len(text) // 10 + 1):
            suffix = text[-width:]
            count = 1
            while len(text) >= width * (count + 1) and text[-width * (count + 1):-width * count] == suffix:
                count += 1
            if count >= 10:
                return text[:len(text) - width * (count - 1)]
    return text


def generate_markdown_batch(requests):
    if not requests:
        return []
    from PIL import Image, ImageStat
    from vllm import SamplingParams
    runtime = get_runtime()
    images, prompts, indexes = [], [], []
    results = [''] * len(requests)
    try:
        for index, (path, prompt) in enumerate(requests):
            with Image.open(path) as source:
                picture = source.convert('RGB')
            images.append(picture)
            max_side = int(os.environ.get('OCR_IMAGE_MAX_SIDE', '1024'))
            if max_side > 0:
                picture.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
            with picture.convert('L') as gray:
                blank = ImageStat.Stat(gray).stddev[0] <= float(os.environ.get('BLANK_PAGE_STDDEV_THRESHOLD', '4'))
            if os.environ.get('BLANK_PAGE_FILTER_ENABLED', 'true').lower() == 'true' and blank:
                continue
            messages = [dict(role='system', content=''), dict(role='user', content=[
                dict(type='image', image=str(path)), dict(type='text', text=prompt)])]
            text = runtime.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            prompts.append(dict(prompt=text, multi_modal_data={'image': picture}))
            indexes.append(index)
        if prompts:
            sampling = SamplingParams(temperature=0.0, top_p=1.0, top_k=-1,
                repetition_penalty=float(os.environ.get('REPETITION_PENALTY', '1.08')),
                max_tokens=int(os.environ.get('MAX_NEW_TOKENS', '4096')), skip_special_tokens=True)
            output = runtime.model.generate(prompts, sampling, use_tqdm=False)
            if len(output) != len(prompts) or any(not item.outputs for item in output):
                raise RuntimeError('OCR engine returned an incomplete batch')
            for index, item in zip(indexes, output, strict=True):
                results[index] = clean_repeated_substrings(item.outputs[0].text).strip()
        return [(result, runtime) for result in results]
    finally:
        for picture in images:
            picture.close()
