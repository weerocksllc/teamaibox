#!/usr/bin/env python3
"""Public entry point for the current source-bound native release gate.

Historical gate v1 and 1.18.16 receipts are preserved, but never accepted here.
Use --require-release --evidence PATH for actual current ARM64 release proof.
"""
try:
    from tools.validate_opencode_native_release import main
except ModuleNotFoundError:
    from validate_opencode_native_release import main

if __name__ == '__main__':
    raise SystemExit(main())
