# Event Bus

NATS JetStream adapter, versioned event envelopes, subject conventions, durable
consumer policy, and delivery metadata. Events wake and coordinate services;
PostgreSQL remains the durable fact store.

topology.v1.json declares the two initial file-backed streams and delivery
defaults. tools/provision_nats_topology.py checks them and, only with --apply,
creates missing streams. It refuses silent changes to an existing stream so
retention/storage drift requires an explicit data migration plan.

