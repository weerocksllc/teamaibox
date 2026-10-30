ALTER TABLE compute.node_enrollments
DROP CONSTRAINT node_enrollments_request_facts_check;

ALTER TABLE compute.node_enrollments
ADD CONSTRAINT node_enrollments_check1 CHECK (
    state = 'issued'
    OR (csr_pem IS NOT NULL AND public_key_fingerprint IS NOT NULL)
);
