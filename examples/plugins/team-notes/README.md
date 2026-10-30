# Team Notes sample ApplicationPlugin

Third-party reference plugin using only `@teamaibox/plugin-sdk` delegated API
access. The container serves browser assets and health endpoints with no host
mount, Docker socket, device, external network, or permanent credential. The
browser receives a short-lived user delegation from the platform host and calls
the platform's files API through `createDelegatedPlatformClient`.

The browser also imports the public preference bridge, applies the effective
locale, direction, Light/Dark theme and complete semantic-token set, and handles
revisioned live preference events without reloading or losing draft state.

This sample is intentionally small and is not the product Team Drive or a
production notes editor.
