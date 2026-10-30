# Synthetic maintenance regression fixture

`synthetic_completed_maintenance.json` is constructed test data, not an appliance log.
All node, transaction, worker, profile, image, configuration and container identities
are synthetic. The example registry is reserved and the timestamps use year 2000.

The fixture retains the relevant regression shape: six dependency-ordered protected
workers, one OCR companion, a completed journal, a 15-minute authority window, and
a non-initial journal revision. Its plan digest is the SHA-256 of the Go JSON
serialization of `ProtectedMaintenancePayload`, including canonical label ordering.
