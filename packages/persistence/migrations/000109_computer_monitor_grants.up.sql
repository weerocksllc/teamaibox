CREATE TABLE platform.computer_monitor_grants (
  computer_id uuid NOT NULL REFERENCES platform.computers(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('view','control')),
  granted_by uuid NOT NULL REFERENCES iam.identities(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (computer_id,identity_id)
);
CREATE INDEX computer_monitor_grants_identity ON platform.computer_monitor_grants(identity_id);
