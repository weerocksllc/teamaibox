# Host dependency exceptions

This directory contains only approved, time-bounded JSON records based on
`../exception.template.json`. An exception must identify the exact component,
owner, necessity, version, security/update impact, uninstall/rollback method,
validation evidence, affected drift keys, approval time, and expiry.

Application services, Web servers, language/build packages, databases, queues,
model runtimes, plugins, Agent sandboxes, source gateways, and product monitoring
are not valid ordinary host exceptions. An expired or malformed record makes the
host check fail; the detector never installs, removes, enables, disables, or
rewrites anything.
