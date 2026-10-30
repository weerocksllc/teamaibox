DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM compute.fleet_service_reservations) THEN
        RAISE EXCEPTION 'Cannot remove accounting for an unconfirmed fleet service';
    END IF;
END $$;
DROP VIEW compute.fleet_service_reservations;
DROP TABLE compute.fleet_service_allocations;
