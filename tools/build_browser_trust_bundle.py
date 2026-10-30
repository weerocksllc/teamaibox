#!/usr/bin/env python3
"""Build a deterministic public-only appliance CA trust handoff bundle."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SAFE_LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$")
CERTIFICATE_BLOCK = re.compile(
    r"-----BEGIN CERTIFICATE-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END CERTIFICATE-----",
    re.MULTILINE,
)


class BrowserTrustBundleError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise BrowserTrustBundleError(message)


def canonical_digest(value: Mapping[str, Any]) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def validate_origin(value: str) -> str:
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError as error:
        raise BrowserTrustBundleError("appliance origin has an invalid port") from error
    require(
        parsed.scheme == "https"
        and parsed.hostname is not None
        and parsed.username is None
        and parsed.password is None
        and parsed.path in {"", "/"}
        and not parsed.query
        and not parsed.fragment,
        "appliance origin must be one exact HTTPS origin",
    )
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    return f"https://{host}{':' + str(port) if port is not None else ''}"


def run_openssl(arguments: Sequence[str], description: str) -> str:
    completed = subprocess.run(
        ["openssl", *arguments],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise BrowserTrustBundleError(f"{description} failed")
    return completed.stdout


def inspect_ca(path: Path) -> dict[str, Any]:
    require(path.is_file(), "CA certificate file is missing")
    payload = path.read_bytes()
    require(len(payload) <= 256 * 1024, "CA certificate file is unexpectedly large")
    text = payload.decode("ascii", errors="strict")
    require("PRIVATE KEY" not in text, "trust bundle input must never contain a private key")
    blocks = CERTIFICATE_BLOCK.findall(text)
    require(len(blocks) == 1, "trust bundle input must contain exactly one CA certificate")
    try:
        der = base64.b64decode("".join(blocks[0].split()), validate=True)
    except ValueError as error:
        raise BrowserTrustBundleError("CA certificate PEM is invalid") from error
    details = run_openssl(("x509", "-in", str(path), "-noout", "-text", "-startdate", "-enddate"), "CA inspection")
    require("CA:TRUE" in details and "Certificate Sign" in details, "trust bundle certificate is not a certificate authority")
    run_openssl(("x509", "-in", str(path), "-noout", "-checkend", "86400"), "CA validity check")
    dates = {}
    for line in details.splitlines():
        stripped = line.strip()
        if stripped.startswith("notBefore="):
            dates["notBefore"] = stripped.split("=", 1)[1]
        elif stripped.startswith("notAfter="):
            dates["notAfter"] = stripped.split("=", 1)[1]
    require(set(dates) == {"notBefore", "notAfter"}, "CA validity dates are missing")
    normalized = CERTIFICATE_BLOCK.search(text)
    assert normalized is not None
    certificate_pem = (
        "-----BEGIN CERTIFICATE-----\n"
        + "\n".join(
            "".join(normalized.group(1).split())[index:index + 64]
            for index in range(0, len("".join(normalized.group(1).split())), 64)
        )
        + "\n-----END CERTIFICATE-----\n"
    ).encode("ascii")
    return {
        "certificatePem": certificate_pem,
        "certificateSha256": "sha256:" + hashlib.sha256(der).hexdigest(),
        **dates,
    }


def deterministic_entry(archive: zipfile.ZipFile, name: str, content: bytes) -> None:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = 0o100644 << 16
    archive.writestr(info, content)


def build_bundle(*, ca_path: Path, origin: str, label: str, output: Path) -> dict[str, Any]:
    require(SAFE_LABEL.fullmatch(label) is not None, "appliance label is invalid")
    selected_origin = validate_origin(origin)
    ca = inspect_ca(ca_path)
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "bundleKind": "teamaibox.browser-trust-handoff",
        "applianceLabel": label,
        "applianceOrigin": selected_origin,
        "caCertificateFile": "teamaibox-appliance-ca.crt",
        "caCertificateSha256": ca["certificateSha256"],
        "certificateNotBefore": ca["notBefore"],
        "certificateNotAfter": ca["notAfter"],
        "containsPrivateKey": False,
        "installsTrustAutomatically": False,
    }
    manifest["manifestDigest"] = canonical_digest(manifest)
    fingerprint = ca["certificateSha256"].removeprefix("sha256:").upper()
    grouped = ":".join(fingerprint[index:index + 2] for index in range(0, len(fingerprint), 2))
    readme = f"""Team AI Box browser trust handoff / 浏览器信任交接包

Appliance / 设备: {label}
Origin / 访问地址: {selected_origin}
CA SHA-256 / CA 指纹: {grouped}

1. Compare this fingerprint with the appliance identity shown through a separate trusted administrator channel.
   必须通过独立可信的管理员渠道核对以上指纹，不能只相信当前未受信任网页。
2. Install teamaibox-appliance-ca.crt only into the intended team browser/device trust store using operating-system administrator controls.
   仅使用操作系统管理员功能，将 teamaibox-appliance-ca.crt 安装到指定团队设备的信任库。
3. Fully restart the browser, open the exact HTTPS origin above, and confirm there is no certificate warning before entering credentials.
   完全重启浏览器，访问以上精确 HTTPS 地址；确认没有证书警告后才能输入账号密码。
4. Do not click through warnings. Remove this CA when the appliance is retired or its CA is replaced.
   不要绕过证书警告；设备退役或 CA 更换后，应删除旧信任锚。

This bundle never contains a private key and does not install trust automatically.
本交接包绝不包含私钥，也不会自动修改系统信任设置。
""".encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix=output.name + ".", suffix=".tmp", dir=output.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with zipfile.ZipFile(temporary_path, "w") as archive:
            deterministic_entry(archive, "teamaibox-appliance-ca.crt", ca["certificatePem"])
            deterministic_entry(archive, "manifest.json", (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"))
            deterministic_entry(archive, "README.txt", readme)
        os.chmod(temporary_path, 0o644)
        temporary_path.replace(output)
    finally:
        temporary_path.unlink(missing_ok=True)
    return {
        "schemaVersion": 1,
        "bundlePath": str(output),
        "bundleSha256": "sha256:" + hashlib.sha256(output.read_bytes()).hexdigest(),
        "manifestDigest": manifest["manifestDigest"],
        "caCertificateSha256": ca["certificateSha256"],
        "applianceOrigin": selected_origin,
        "containsPrivateKey": False,
        "installationPerformed": False,
        "browserTrustVerified": False,
        "releaseEvidenceEligible": False,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ca", type=Path, required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = build_bundle(ca_path=args.ca, origin=args.origin, label=args.label, output=args.output)
    except (BrowserTrustBundleError, OSError, UnicodeError) as error:
        parser.exit(2, f"browser trust bundle failed: {error}\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
