ALTER TABLE compute.node_enrollments
DROP CONSTRAINT node_enrollments_check1;

ALTER TABLE compute.node_enrollments
ADD CONSTRAINT node_enrollments_request_facts_check CHECK (
    state IN ('issued', 'expired', 'revoked')
    OR (csr_pem IS NOT NULL AND public_key_fingerprint IS NOT NULL)
);
