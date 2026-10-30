CREATE TABLE platform.phone_record_removals (
  phone_id uuid PRIMARY KEY REFERENCES platform.phones(id),
  owner_id uuid NOT NULL REFERENCES iam.identities(id),
  node_id uuid NOT NULL,
  pool_id text NOT NULL,
  volume_id uuid NOT NULL,
  data_erased boolean NOT NULL DEFAULT false CHECK (data_erased = false),
  removed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
