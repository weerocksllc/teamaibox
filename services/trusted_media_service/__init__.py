"""Trusted media lifecycle and admission primitives.

This package intentionally contains no AirPlay receiver or codec binary.  Those
artifacts are admitted only after the separately reviewed, digest-bound release
package is complete.
"""

from .release_controller import MediaReleaseController, MediaReleaseError
from .viewer_token_issuer import LiveKitViewerTokenIssuer, ViewerTokenError
from .runtime_api import PLATFORM_PEER, PRIVACY_POLICY, RuntimeApiError, TrustedMediaRuntimeApi

__all__ = [
    "LiveKitViewerTokenIssuer",
    "MediaReleaseController",
    "MediaReleaseError",
    "ViewerTokenError",
    "PLATFORM_PEER",
    "PRIVACY_POLICY",
    "RuntimeApiError",
    "TrustedMediaRuntimeApi",
]
