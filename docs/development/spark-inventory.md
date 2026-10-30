# Sanitized DGX Spark inventory

`tools/spark-inventory` collects a versioned, read-only hardware and runtime
baseline for the installed DGX Spark appliance. It uses only Python's standard library and emits
JSON on standard output.

```sh
./tools/spark-inventory --pretty
```

From a development workstation, collect the appliance without copying a file to it
(substitute the installation's SSH address):

```sh
ssh operator@appliance.example python3 - --pretty < tools/spark_inventory.py
```

For a retained baseline, use the allowlisted capture wrapper. It streams the
collector over SSH, validates the returned document again on the workstation,
and atomically writes only sanitized JSON under the logical node directory:

```sh
python3 tools/capture_spark_inventory.py --target dgx-spark-dev-01
```

The SSH address identifies transport only and is never copied into the report.

The collector uses explicit field allowlists and never requests or emits:

- host names, IP addresses, or MAC addresses;
- hardware serials, device UUIDs, machine IDs, or boot IDs;
- environment variables, credentials, tokens, or command stderr;
- process command lines, user mount paths, or user file content.

Before serialization, the complete report is checked again for forbidden keys
and MAC/IPv4-shaped values. A violation fails closed with no JSON report.

The command is observational only. It does not use `sudo`, change Docker or CDI
configuration, install packages, pull images, start containers, modify network
links, or write to the target node.
