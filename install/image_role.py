"""Verify shipped UI image roles without starting or modifying donor services."""
from offline_common import need


def verify_application_role(role, actual):
    if not role.endswith('-plugin'):
        return
    config = actual.get('Config') or {}
    declared = (config.get('Labels') or {}).get('com.teamaibox.plugin.id')
    expected = 'official.' + role.removesuffix('-plugin')
    if declared is not None:
        need(declared == expected, 'application image is assigned to the wrong role: ' + role)
    else:
        # Some previously built official images predate OCI plugin labels.
        # Require their exact application entrypoint; target installation also
        # verifies the running /health/ready plugin ID and version before use.
        entrypoint = config.get('Entrypoint') or []
        need(entrypoint == ['node', '/opt/teamaibox/apps/' + role + '/src/server.mjs'],
             'unlabelled application image has no matching entrypoint: ' + role)
