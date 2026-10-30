# API authorization boundary

Every protected operation resolves current access from the repository and asks
for one registered permission against an explicit appliance or resource scope.
The result is not trusted from a browser session or plugin token. A denied call
emits a redacted `authorization.denied` audit event before returning a stable
403 error.

HTTP handlers should authenticate the session first, derive the target scope
from canonical server-side resource data, and call `AuthorizationService.require`
before reading or mutating protected content.

