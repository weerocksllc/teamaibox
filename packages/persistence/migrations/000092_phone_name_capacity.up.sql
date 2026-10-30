-- Display names are user text, not runtime identifiers or filesystem paths.
ALTER TABLE platform.phones DROP CONSTRAINT phones_name_check;
ALTER TABLE platform.phones ADD CONSTRAINT phones_name_check
  CHECK (length(name)>0 AND name=btrim(name) AND name !~ '[[:cntrl:]]');
