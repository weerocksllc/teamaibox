DROP TRIGGER encrypted_blob_rewrap_boundary ON objects.encrypted_blobs;
DROP FUNCTION objects.enforce_encrypted_blob_rewrap();
DROP TABLE objects.encrypted_blobs;
DROP SCHEMA objects;
