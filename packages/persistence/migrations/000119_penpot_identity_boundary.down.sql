-- Do not sever persistent profile ownership or pretend old code understands it.
DO $$ BEGIN
    RAISE EXCEPTION 'Penpot identity mappings must be retained. Disable the design application before a compatible software rollback; destructive schema downgrade is unsupported.';
END $$;
