# AI Drawing ApplicationPlugin

This first-party plugin is an isolated, dependency-free Web container. It calls
only the platform's same-origin queued compute and protected-object APIs. The
container never receives browser cookies or authorization headers from the Web
boundary; user API calls go directly from the trusted official iframe to the
platform boundary.

The committed `manifest.release-template.json` is deliberately **not an
installable signed manifest**. The release pipeline must replace the OCI image
reference and digest after an ARM64 build, attach SBOM/provenance evidence, and
sign the canonical manifest with the protected official release key. Treating
the template placeholders as a release is a build failure, never a development
shortcut.

The logical model alias is `local/drawing-default`. Scheduler routing must
resolve it only to a `Certified` image profile. Until the Spark deployment and
validation gate succeeds, submissions fail visibly with capability-unavailable;
the UI never claims that an uncertified model is ready.
