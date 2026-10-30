# DGX Spark telemetry probe

Run the read-only, sanitized telemetry probe locally:

```sh
tools/spark-telemetry-probe --pretty
```

Run it on a development appliance without copying a persistent executable:

```sh
ssh appliance-user@appliance-host 'python3 - --pretty' \
  < tools/spark_telemetry_probe.py
```

The probe reads only aggregate `/proc` counters, its own process and cgroup-v2
memory counters, allowlisted `nvidia-smi` fields, aggregate physical-disk I/O,
and physical-interface byte/packet counters. It omits host and machine IDs,
network addresses, MAC addresses, disk names, process lists and command lines,
environment variables, credentials, and user paths or content.

An idle zero is a supported observation, not evidence that a metric is absent.
An unavailable counter is emitted explicitly with `status: unsupported` and a
reason. The probe is a capability check; production collection intervals,
retention, labels, and authorization belong to the observability subsystem.

