# User Activity and Service Availability Boundary

`GET /api/v1/user/activity` is the ordinary-user projection of asynchronous
work and AI service availability. It requires an authenticated local-user
session with `task:own:view`. `POST /api/v1/user/tasks/{taskId}/cancel`
additionally requires `task:own:manage`, same-origin validation, and CSRF.

The task query is constrained by the authenticated identity before records are
projected. The response contains only a task identifier, public task kind and
title key, normalized state/progress, generic wait information, actionable
failure codes, and scoped artifact references. It deliberately excludes owner
identifiers, requests, prompts, filenames, raw error messages, model/profile
selection, provider route, node/worker identity, queue internals, and other
users' workload counts. Cross-owner lookups retain not-found semantics.

Service availability is independently projected onto the installed first-party
application catalog. Managed-node inventory, fresh aggregate queue telemetry,
and healthy external-provider operation mappings may contribute to the result,
but their identifiers and hardware details are never returned. Wait values are
explicitly labelled: zero means no observed queue; non-zero values use the
oldest queued age as a visible estimate proxy; absent evidence remains
`unavailable` rather than being fabricated.

The browser polls the projection every 15 seconds and presents text together
with status icons so state is not conveyed by color alone. The user surface has
no administrator links or resource controls. Agent operation confirmations stay
inside the corresponding Assistant conversation and are not represented as
compute approval.
