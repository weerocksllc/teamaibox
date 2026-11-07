-- Retaining these links prevents a rollback from treating managed teams as
-- unrelated private spaces. Do not erase identity or ownership information.
DO $$ BEGIN
    RAISE EXCEPTION 'Design team mappings must be preserved; destructive schema downgrade is unsupported.';
END $$;
