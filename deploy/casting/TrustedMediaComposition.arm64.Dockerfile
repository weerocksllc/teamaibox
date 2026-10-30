# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Integrated development candidate; activation still requires media admission.
# Build preflight must verify this local tag has image ID
# sha256:fe385c9f75883b62cd4a3728d04ad5745441ed5b6ee78053081c9183e7e89eeb.
# Docker Desktop cannot resolve this unpublished local image via registry digest.
FROM ${BUILD_PARENT_1}
USER 0:0
# The historical base contains AppleDouble sidecars from a macOS tar export.
# Remove only verified metadata with a matching module, inside this image layer.
RUN python3 -c 'from pathlib import Path; root=Path("/opt/teamaibox/services/trusted_media_service"); files=list(root.glob("._*.py")); assert all(p.read_bytes()[:4] == bytes.fromhex("00051607") and p.with_name(p.name[2:]).is_file() for p in files); [p.unlink() for p in files]'
COPY services/trusted_media_service /opt/teamaibox/services/trusted_media_service
COPY tools/probe_trusted_media_hdmi.py /opt/teamaibox/tools/probe_trusted_media_hdmi.py
ENV PYTHONPATH=/opt/teamaibox PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
LABEL org.teamaibox.claim="development-integrated-media-not-product-accepted"
