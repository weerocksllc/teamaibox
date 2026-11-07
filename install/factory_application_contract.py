"""Declared application identities and explicit multi-service image bindings."""
from offline_common import need
import re

# Identities, not an application count. Existing package identities stay stable.
BASE_APPLICATIONS = frozenset('official.' + name for name in (
    'messaging', 'team-drive', 'drawing', 'ocr', 'asr', 'translation',
    'virtual-phones', 'virtual-computers', 'wireless-casting'))


def validate_application_set(applications, required, *, profile='appliance'):
    keys = [row['manifest']['id'] for row in applications]
    need(isinstance(required, (list, tuple, set, frozenset)) and required,
         'declared required applications missing')
    need(profile in ('appliance', 'design'), 'unknown application registration profile')
    complete = BASE_APPLICATIONS <= set(required) if profile == 'appliance' else set(required) == {'official.penpot'}
    need(len(required) == len(set(required)) and complete,
         'required application identities conflict or omit shipped applications')
    need(len(keys) == len(set(keys)) and set(keys) == set(required),
         'shipped application catalog does not match required identities')


def bind_application_images(manifest, mapping):
    """Each native service keeps its own image; no UI-image substitution."""
    images = manifest.get('images', [])
    names = [image.get('name') for image in images]
    need(images and len(names) == len(set(names)) and set(names) == set(mapping),
         'application image mapping is incomplete or duplicated')
    roles = list(mapping.values())
    need(len(roles) == len(set(roles)) and all(isinstance(role, str)
         and re.fullmatch(r'[a-z][a-z0-9-]{1,63}', role) for role in roles),
         'application service roles must be distinct')
    services = []
    for image in images:
        variants = image.get('variants', [])
        need(len(variants) == 1 and variants[0].get('architecture') == 'linux/arm64/v8',
             'application image must have exactly one ARM64 variant')
        role = mapping[image['name']]
        variants[0].update(reference='@@IMAGE.' + role + '@@', digest='@@IMAGE.' + role + '@@')
        services.append(dict(role=role, imageName=image['name'],
                             readiness='plugin-http' if len(images) == 1 else 'container-health'))
    return services


def application_services(row):
    images = row['manifest']['images']
    services = row.get('services')
    if services is None:
        need(len(images) == 1, 'legacy catalog cannot describe multiple service images')
        services = [dict(role=row['role'], imageName=images[0]['name'], readiness='plugin-http')]
    by_name = {image['name']: image for image in images}
    need(len(by_name) == len(images) and len(services) == len(images)
         and {service.get('imageName') for service in services} == set(by_name)
         and len({service.get('role') for service in services}) == len(services),
         'application service/image mapping conflicts')
    result = []
    for service in services:
        need(isinstance(service.get('role'), str) and re.fullmatch(r'[a-z][a-z0-9-]{1,63}', service['role']),
             'invalid application service role')
        variants = by_name[service['imageName']].get('variants', [])
        need(len(variants) == 1 and variants[0].get('architecture') == 'linux/arm64/v8',
             'application image architecture mismatch')
        need(service.get('readiness', 'plugin-http') in ('plugin-http', 'container-health'),
             'application readiness contract missing')
        result.append({**service, 'readiness': service.get('readiness', 'plugin-http'), 'digest': variants[0]['digest']})
    return result
