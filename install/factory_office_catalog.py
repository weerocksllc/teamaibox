#!/usr/bin/env python3
"""Register fresh office profile metadata, never import a development database.

This phase does not mark models healthy. Readiness is committed separately,
only after the actual new workers are running and inspected.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import uuid

from factory_guest_catalog import sql_value
from offline_common import need

ALIASES = {'assistant': 'local/qwen3.8-27b-nvfp4', 'drawing': 'local/drawing-default',
           'ocr': 'local/ocr-default', 'asr': 'whisper-small-ct2-int8',
           'translation': 'local/translation-default', 'embedding': 'local/embedding-default'}
PRECISION = {'assistant': 'nvfp4', 'translation': 'nvfp4', 'embedding': 'bf16',
             'ocr': 'bf16', 'asr': 'int8', 'drawing': 'bf16'}
OPERATIONS = {'chat': ['responses', 'chat.completions'], 'image-generation': ['images.generations'],
              'ocr': ['ocr'], 'asr': ['audio.transcriptions'], 'translation': ['translate'],
              'embedding': ['embeddings']}


def fingerprint(value):
    return 'sha256:' + hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                               separators=(',', ':')).encode()).hexdigest()


def model_license(profile, asset):
    source = profile['license']
    texts = [f for f in asset['files'] if Path(f['path']).name.lower() in
             ('license', 'license.txt', 'license.md', 'licence', 'licence.txt')]
    text_digest = source.get('textDigest')
    if not text_digest:
        need(len(texts) == 1, 'include the exact model license text in asset: ' + asset['role'])
        text_digest = 'sha256:' + texts[0]['sha256']
    # Conditional upstream terms are not silently promoted to an unconditional
    # commercial approval by the installer.
    permissive = source.get('spdxId') in ('Apache-2.0', 'MIT')
    return dict(name=source['name'], spdxId=source.get('spdxId'),
                usage='commercial' if permissive else 'unknown',
                reviewStatus='approved' if source.get('reviewStatus') == 'approved' else 'pending',
                textDigest=text_digest, evidenceRef=None)


def quantization(profile, asset, precision):
    if precision == 'bf16':
        return None
    metadata = profile['precision']
    # Hash the actual published conversion/config metadata, not a made-up
    # benchmark or the identity of a development installation.
    recipe = metadata.get('recipeDigest', metadata.get('recipeSha256', fingerprint(metadata)))
    parameters = [f for f in asset['files'] if Path(f['path']).name in ('config.json', 'hf_quant_config.json')]
    need(parameters, 'quantized model configuration missing: ' + asset['role'])
    return dict(scheme=precision, tool='ModelOpt' if precision == 'nvfp4' else 'CTranslate2',
                toolVersion=metadata.get('modelOptRevision', 'upstream snapshot; version not recorded'),
                recipeDigest=recipe, parametersDigest=fingerprint(parameters), calibrationDatasetDigest=None)


def documents(runtime, release, installation_id, created_at):
    """The release inventory, not old database IDs, binds the model content."""
    assets = {row['role']: row for row in release['assets']}
    result = {}
    for role, p in runtime['profiles'].items():
        asset = assets[role + '-model']
        weights = fingerprint(asset['files'])
        size = sum(f['size'] for f in asset['files'])
        capability = str(uuid.uuid5(uuid.UUID(installation_id), 'capability:' + p['capability']))
        payload = runtime['workers'][role]
        resource = dict(accountingMode='observed', cpuMillis=payload['limits']['cpuQuotaMicros'] // 100,
            unifiedMemoryBytes=p['declaredResidentBytes'], storageBytes=size, networkBitsPerSecond=0,
            acceleratorUnits=int(bool(payload.get('devices', []))), codecSessions=0,
            evidenceRef=None)
        # No invented quality benchmark/certification or shared account.
        result[role] = dict(schemaVersion=1, profileId=p['modelProfileId'], profileKey=p['profileKey'],
            capabilityId=capability, executionKind='local',
            source=dict(model=p['model'], revision=p['revision'], license=model_license(p, asset),
                        provenance=dict(sourceDigest=weights, sourceUri='object://release/' + release['releaseId'] + '/' + role,
                                        publisher=p['model'].split('/')[0], retrievedAt=created_at, evidenceRef=None)),
            artifacts=[dict(name=role + '-model', role='weights', digest=weights, sizeBytes=size,
                            mediaType='application/vnd.teamaibox.model-snapshot+json')],
            artifactDigest=weights, engine=dict(name=p['engine']['name'].lower(), version=p['engine']['version'],
                runtime='docker', runtimeVersion='offline-image', imageDigest=p['imageDigest'],
                configurationDigest=p['configurationDigest']), precision=PRECISION[role],
            quantizationRecipe=quantization(p, asset, PRECISION[role]),
            compatibility=dict(architectures=['linux/arm64/v8'],
                hardware=dict(acceleratorFamilies=['nvidia-gb10-blackwell'] if payload.get('devices', []) else [],
                    minimumComputeCapability=None, minimumUnifiedMemoryBytes=p['declaredResidentBytes'],
                    minimumCpuCores=1, codecDirections=dict(encode=0, decode=0)),
                software=dict(os='linux', kernelRange=None, driverRange=None, cudaRange=None, containerToolkitRange=None)),
            apiContracts=['teamaibox.' + p['capability'] + '@v1'],
            limits=dict(maximumInputBytes=None, maximumOutputBytes=None, maximumContextTokens=None,
                        maximumOutputTokens=None, maximumBatchSize=1, maximumDurationSeconds=None,
                        maximumConcurrentRequests=1), resourceEnvelope=resource,
            coldStart=dict(estimatedMilliseconds=0, artifactReadBytes=size, evidenceRef=None),
            dataPolicy=dict(allowedDataClasses=['public', 'internal', 'confidential', 'restricted'], externalProcessing='forbidden'),
            knownLimitations=['First-load readiness is determined from this installation, not copied from another box.',
                              'Cold-start duration has not been measured on this installation.'],
            validationEvidence=[], certification=dict(state='validating', evidenceRefs=[]), exclusive=False,
            createdAt=created_at)
    return result


def statements(runtime, docs, check=False):
    """Atomic insert-or-assert. Conflicts preserve all existing rows."""
    q = sql_value
    def js(value):
        return q(json.dumps(value, ensure_ascii=False, separators=(',', ':'))) + '::jsonb'
    commands, assertions = [], []
    for role, doc in docs.items():
        profile = runtime['profiles'][role]
        capability_key = profile['capability']
        modality = {'image-generation': 'image', 'ocr': 'ocr', 'asr': 'asr',
                    'translation': 'translation', 'embedding': 'embedding', 'chat': 'chat'}[capability_key]
        # These six IDs are installation-derived. A conflicting capability
        # key is preserved and rejected, never silently adopted.
        commands.append('INSERT INTO compute.capabilities(id,capability_key,modality,contract_version,api_operations) VALUES (' +
            ','.join((q(doc['capabilityId']), q(capability_key), q(modality), "'v1'", js(OPERATIONS[capability_key]))) +
            ') ON CONFLICT(capability_key) DO NOTHING;')
        document = js(doc)
        cap = q(doc['capabilityId'])
        fields = ('id,profile_key,capability_id,source_model,source_revision,engine,engine_version,precision,'
                  'artifact_digest,quantization_recipe,compatibility,declared_resources,certification_state,exclusive,'
                  'placement_class,maintenance_generation,recovery_state,lifecycle_reason_key')
        values = [q(doc['profileId']), q(doc['profileKey']), cap, q(doc['source']['model']), q(doc['source']['revision']),
                  q(doc['engine']['name']), q(doc['engine']['version']), q(doc['precision']), q(doc['artifactDigest']),
                  js(doc['quantizationRecipe'] or {}), js(doc['compatibility']), js(doc['resourceEnvelope']),
                  "'validating'", 'false', "'protected-resident'", '1', "'recovering'", "'model.lifecycle.factory-install'"]
        commands.append('INSERT INTO compute.model_profiles(' + fields + ') VALUES (' + ','.join(values) + ') ON CONFLICT(id) DO NOTHING;')
        fp = fingerprint(doc)[7:]
        commands.append('INSERT INTO compute.model_profile_registrations(profile_id,profile_key,profile_fingerprint,profile_document,operation_key,created_at) VALUES (' +
            ','.join((q(doc['profileId']), q(doc['profileKey']), "decode(" + q(fp) + ",'hex')", document,
                      q('factory:' + doc['profileId']), q(doc['createdAt']))) + ') ON CONFLICT(profile_id) DO NOTHING;')
        assertions.append('IF NOT EXISTS (SELECT 1 FROM compute.model_profiles p JOIN compute.model_profile_registrations r ON r.profile_id=p.id WHERE p.id=' +
            q(doc['profileId']) + ' AND p.profile_key=' + q(doc['profileKey']) + ' AND p.capability_id=' + cap +
            ' AND p.artifact_digest=' + q(doc['artifactDigest']) + ' AND p.placement_class=\'protected-resident\'' +
            ' AND r.profile_document=' + document + " AND r.profile_fingerprint=decode(" + q(fp) + ",'hex'))" +
            " THEN RAISE EXCEPTION 'factory office profile conflict'; END IF;")
    return ('BEGIN READ ONLY;' if check else 'BEGIN;\n' + '\n'.join(commands)) + '\nDO $check$ BEGIN\n' + \
        '\n'.join(assertions) + '\nEND $check$;\nCOMMIT;\n'
