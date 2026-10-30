# Authorization model

Team AI Box uses appliance-local identities and a closed permission catalog.
Authentication establishes who is calling; authorization is resolved again at
each API operation from current role bindings or service-account grants. Browser
visibility is derived from the same permission keys, but hiding a control never
counts as authorization.

## Built-in roles

| Role | Scope | Intended boundary |
| --- | --- | --- |
| Owner | Appliance | Every registered permission; final active owner is protected |
| System administrator | Appliance | Users, roles, credentials, security, storage, sources, updates, and audit |
| Compute administrator | Appliance | Nodes, model placement, resource policy, queues, providers, and audit |
| Application administrator | Appliance | Application catalog and plugin lifecycle |
| Developer | Appliance | Ordinary applications, and self-issued bounded developer credentials |
| Team administrator | Appliance or one team | Team membership and team message/file administration |
| Member | Appliance or one team | Ordinary applications, AI calls, own tasks, messages, and files |
| Guest | Appliance or one team | Assigned catalog and read-only team message/file access; no AI invocation by default |

System roles are fixed policy inputs, not identity-provider groups. This release
does not expose LDAP, Active Directory, OIDC, enterprise SSO, MFA, or external
group synchronization.

## Service accounts

Service accounts do not inherit role permissions. Each grant names one known
permission, a resource kind and key, an expiry, grantor, and revocation state.
An appliance-wide grant must explicitly use the `appliance/*` scope. The API
ignores any role accidentally attached to a service identity, and the database
rejects creating such a binding.

## API credentials

Ordinary members and guests have no personal API-key entry and cannot create
credentials. A user must hold the explicit Developer role (or Owner role) to
issue a credential to the same identity. Developer credentials expire within
90 days, contain only allowlisted non-administrative scopes, and are rechecked
against the user's current roles on every call.

System administrators and owners can issue service credentials only within the
target service account's active grants; a credential cannot outlive a covering
grant. Service credentials expire within 365 days. Every secret is returned
exactly once, while persistence stores only an HMAC-SHA-256 digest and a short
non-secret hint. Issue, successful use, denial, and revocation are audited
without recording the secret or digest.

## Enforcement rules

1. An authenticated active identity is required.
2. The handler resolves the canonical target resource on the server.
3. The API checks the current binding or grant for that exact target.
4. Every denial returns the stable `access_denied` error and emits a redacted
   audit event containing actor, operation, required permission, target kind,
   and reason.
5. The Web shell independently omits inaccessible routes and actions and fails
   closed when a plugin declares an unknown permission.
