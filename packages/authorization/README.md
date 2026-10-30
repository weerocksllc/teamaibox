# Authorization

Shared, framework-independent permission catalog and decision engine for the
Platform API and Web shell. The API remains authoritative; the Web shell uses
the same permission keys only to omit unavailable routes and controls.

Local users receive permissions from role bindings. Appliance bindings apply
globally, while team bindings apply only to the matching team. Service accounts
receive no role defaults and can act only through explicit, unexpired resource
grants.

