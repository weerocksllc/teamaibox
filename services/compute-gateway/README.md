# Agent Compute Gateway

This service is the only compute data plane visible to Agent sandboxes. It validates a short-lived, user- and sandbox-bound HMAC credential, permits only the declared OpenAI-compatible Agent routes and aliases, projects the approved alias to a platform model route, and forwards the same signed identity to the platform durable compute queue.

The platform API independently verifies the credential and records the resulting queue job against the original user identity. The gateway never accepts physical worker addresses, never exposes provider credentials, and does not share a network with Agent sandboxes that would let them bypass it.
