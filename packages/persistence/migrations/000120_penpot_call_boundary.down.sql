-- Older software must not silently resume a connection without its boundary.
DO $$ BEGIN
    RAISE EXCEPTION 'Disable design AI connections before a compatible software rollback; destructive schema downgrade is unsupported.';
END $$;
