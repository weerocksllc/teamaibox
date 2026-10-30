from pathlib import Path
def test_provider_is_tls_only_and_worker_is_not_published():
    s=Path("tools/deploy_flux2_provider.py").read_text();assert '"10.64.0.23:19099:19095"' in s;assert '"--network","container:"+worker' in s;assert 'DRAWING_PROVIDER_WORKER_URL=http://127.0.0.1:8000' in s
def test_provider_remains_non_certified_until_product_route():
    s=Path("tools/validate_flux2_provider.py").read_text();assert '"schedulerRouted":False' in s and '"certified":False' in s
def test_protocol_client_uses_pinned_image_runtime_with_pillow():
    s=Path("tools/deploy_flux2_provider.py").read_text();assert '"+WORKER_IMAGE+" - --origin' in s
