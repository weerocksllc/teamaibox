-- Short-lived authenticated context only. No design payloads, tool code,
-- bearer tokens, execution queue or second permission system.
CREATE TABLE design.editor_connections (
    identity_id uuid PRIMARY KEY REFERENCES iam.identities(id) ON DELETE RESTRICT,
    generation bigint NOT NULL CHECK (generation > 0 AND generation < 9007199254740991),
    binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
    heartbeat_at timestamptz NOT NULL,
    disconnected_at timestamptz
);
CREATE TABLE design.call_proofs (
    proof_hash bytea PRIMARY KEY CHECK (octet_length(proof_hash) = 32),
    native_call jsonb NOT NULL CHECK (jsonb_typeof(native_call) = 'object'),
    binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 seconds')
);
CREATE INDEX call_proofs_expiry ON design.call_proofs (expires_at);
CREATE TABLE design.editor_deliveries (
    ticket_hash bytea PRIMARY KEY CHECK (octet_length(ticket_hash) = 32),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '10 seconds')
);
CREATE INDEX editor_deliveries_expiry ON design.editor_deliveries (expires_at);
