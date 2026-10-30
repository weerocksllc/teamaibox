"""Import the production FLUX.2 worker implementation for local tests."""

from __future__ import annotations

import importlib.util
from pathlib import Path


_SOURCE = Path(__file__).resolve().parents[1] / "drawing-worker" / "flux2_comfy_server.py"
_SPEC = importlib.util.spec_from_file_location("teamaibox_flux2_comfy_server", _SOURCE)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError("FLUX.2 worker source could not be loaded")
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)

globals().update({name: value for name, value in vars(_MODULE).items() if not name.startswith("__")})
