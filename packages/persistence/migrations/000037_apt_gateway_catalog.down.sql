DROP TRIGGER apt_snapshots_append_only ON source_center.apt_snapshots;
DROP FUNCTION source_center.reject_apt_snapshot_mutation();
DROP TABLE source_center.apt_snapshots;
DROP TABLE source_center.apt_packages;
