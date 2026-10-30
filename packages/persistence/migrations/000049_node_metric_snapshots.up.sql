CREATE TABLE compute.node_metric_snapshots (
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    node_generation integer NOT NULL CHECK (node_generation > 0),
    sequence bigint NOT NULL CHECK (sequence > 0 AND sequence <= 9007199254740991),
    observed_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL,
    stale_after_milliseconds integer NOT NULL CHECK (stale_after_milliseconds BETWEEN 5000 AND 300000),
    snapshot_digest bytea NOT NULL CHECK (octet_length(snapshot_digest)=32),
    snapshot jsonb NOT NULL CHECK (
        jsonb_typeof(snapshot)='object'
        AND snapshot ?& ARRAY['schemaVersion','observedAt','sequence','collector','domains','processes','workers','models','jobs','queues','reservations','coreServices']
        AND (snapshot->>'schemaVersion')::integer=1
        AND (snapshot->>'sequence')::bigint=sequence
        AND (snapshot->>'observedAt')::timestamptz=observed_at
        AND jsonb_typeof(snapshot->'domains')='object'
        AND (snapshot->'domains') ?& ARRAY['cpu','unifiedMemory','accelerator','storage','network','codecs']
        AND jsonb_typeof(snapshot->'processes')='array'
        AND jsonb_array_length(snapshot->'processes')<=512
        AND jsonb_typeof(snapshot->'workers')='array'
        AND jsonb_array_length(snapshot->'workers')<=512
        AND jsonb_typeof(snapshot->'models')='array'
        AND jsonb_array_length(snapshot->'models')<=512
        AND jsonb_typeof(snapshot->'queues')='array'
        AND jsonb_array_length(snapshot->'queues')<=256
        AND jsonb_typeof(snapshot->'coreServices')='array'
        AND jsonb_array_length(snapshot->'coreServices')<=256
    ),
    PRIMARY KEY (node_id,node_generation,sequence)
);

CREATE INDEX node_metric_snapshots_latest_idx
ON compute.node_metric_snapshots(node_id,node_generation DESC,sequence DESC);

CREATE INDEX node_metric_snapshots_observed_idx
ON compute.node_metric_snapshots(observed_at DESC);
