# Internal and external compute routing policies

Routing policy is an administrator-owned, revision-fenced registry. Policies
can apply appliance-wide or select an exact capability, operation, team, and
set of data classes. Resolution is deterministic: the most specific matching
selector wins, then administrator priority, then policy key. If nothing
matches, the fail-closed default is `internal_only`.

The five modes are:

- `internal_only`: external candidates are hard-rejected;
- `internal_first`: all eligible local/managed candidates precede external
  overflow regardless of score;
- `external_first`: eligible external candidates precede internal fallback;
- `weighted`: all candidates share one score order, with optional exact
  administrator weights per logical target;
- `pinned`: only the exact target and/or model profile can remain eligible.

Every mode still runs all hard filters before ordering: target and certified
profile state, operation, data classification, explicit external-processing
approval, provider contract, provider health freshness, capacity/concurrency,
fairness, and model policy. `localOnly` on a job always rejects every external
provider, including an externally pinned target. An administrator cannot use a
routing policy to override that data boundary.

The internal scheduler result contains the selected tier, stable reason code,
eligible/rejected targets, and rejection counts. User-facing compute resources
continue to expose only logical model and task facts; physical nodes, external
endpoints, provider credentials, and internal target identifiers are not added
to public results.

Policies are managed only below `/api/v1/admin/routing-policies`. Personal users
have no policy mutation surface. The PostgreSQL record stores no credential and
uses optimistic revisions so two administrators cannot silently overwrite one
another.
