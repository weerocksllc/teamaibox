# Platform module boundaries

Team AI Box starts as a modular control plane plus independently deployable
resource- or trust-sensitive services. The catalog in
architecture/module-catalog.json is machine validated and is the authoritative
list of component ownership and static dependencies.

~~~mermaid
flowchart LR
    Web["Web Shell"] --> API["Platform API"]
    API --> DB["Persistence / PostgreSQL"]
    API --> Bus["Event Bus / JetStream"]
    API --> Contracts["Contracts"]

    Scheduler["Scheduler"] --> DB
    Scheduler --> Bus
    Scheduler --> Contracts
    Scheduler --> Node["Node Agent"]

    Plugins["Plugin Runtime"] --> DB
    Plugins --> Bus
    Bridge["Agent Bridge"] --> DB
    Bridge --> Bus
    Objects["Object Service"] --> DB
    Objects --> Bus
    Messaging["Messaging"] --> DB
    Messaging --> Bus
    Sources["Source Gateway"] --> DB
    Sources --> Bus

    API --> Runtime["Service Runtime"]
    Scheduler --> Runtime
    Plugins --> Runtime
    Bridge --> Runtime
    Objects --> Runtime
    Messaging --> Runtime
    Sources --> Runtime
    Runtime --> Config["Configuration"]
    Runtime --> Observability["Observability"]
    API --> Secrets["Protected Secrets"]
    Scheduler --> Secrets
    Objects --> Secrets
~~~

The arrow from scheduler to Node Agent is a runtime protocol relationship; the
catalog records only source/build dependencies, so these services both depend
on versioned contracts instead of importing one another.

## Dependency rules

- Browser code uses public contracts, the Plugin SDK, and the UI system. It
  never imports persistence, event-bus, Docker, or node-control code.
- Platform API owns the trusted public boundary and modular business
  transactions. Independent services do not reach through its private modules.
- PostgreSQL is the fact store. JetStream delivers durable notifications and
  commands but is not the only copy of job, message, or configuration state.
- Node Agent is the only component permitted to control Docker and local
  accelerator/codec devices. It consumes versioned protocols and never links
  platform business modules.
- Application and compute plugins depend only on the public Plugin SDK and
  contracts. They never receive the Docker socket or permanent storage keys.
- Source policy is shared, while Pip, NPM, and APT protocol data planes remain
  separate adapters.
- OpenCode remains an external, digest-pinned upstream service. Only Agent
  Bridge adapters may speak its upstream-specific protocol.
- Node services use the shared runtime for correlation, errors, ordered startup,
  readiness, draining, and rollback. Configuration is validated before startup;
  secret values are accessed only through the protected-secrets abstraction.

## Runtime choice

The browser and control/services use TypeScript on Node 24 LTS so schemas,
events, SDKs, and UI types can share one generation pipeline. The browser uses
React with semantic design tokens and namespaced locale catalogs. Node Agent
uses Go 1.26 for a small ARM64 Linux binary at the privileged system boundary.
Container and dependency digests are established separately by deployment and
supply-chain tasks.
