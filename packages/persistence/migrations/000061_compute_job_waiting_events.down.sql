UPDATE compute.job_events
SET event_kind = 'state'
WHERE event_kind = 'waiting';

ALTER TABLE compute.job_events
DROP CONSTRAINT job_events_event_kind_check;

ALTER TABLE compute.job_events
ADD CONSTRAINT job_events_event_kind_check CHECK (event_kind IN (
    'state', 'progress', 'progress_reset', 'result',
    'retry_guidance', 'cancellation_requested'
));
