# Service runtime

Shared Node service lifecycle for explicit dependency graphs, ordered startup,
bounded readiness probes, reverse-order rollback, draining, and consistent
health endpoints. Liveness only reports that the process can answer; readiness
remains false until every registered component is started and healthy.

Startup failures never leave the coordinator ready. Components that already
started are stopped in reverse order, and probe details are reduced to stable
reason codes before they reach health responses.
