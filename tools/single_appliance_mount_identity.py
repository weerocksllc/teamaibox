"""Stable public digest for Docker mounts; input order is not configuration."""
import hashlib
import json


def mount_identity(mounts):
    values = [{key: item.get(key) for key in ("Type", "Source", "Destination", "RW")}
              for item in mounts]
    values.sort(key=lambda item: (item["Destination"] or "", item["Type"] or "",
                                  item["Source"] or "", bool(item["RW"])))
    return "sha256:" + hashlib.sha256(json.dumps(values, sort_keys=True,
            separators=(",", ":")).encode()).hexdigest()
