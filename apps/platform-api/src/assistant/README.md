# Assistant domain

This module owns the stable Team AI Box conversation contract. Answer-only and
Agent-capable runs share one history and one ordered, resumable event stream.
Model routing, usage, tool activity, artifact references, cancellation, and
initiating-user operation confirmations are represented as platform events.

Execution is injected through `answerRunner` and `agentRunner`. The Agent runner
is intentionally not an OpenCode client: the later Agent Bridge adapts pinned,
unmodified `opencode serve` versions behind this runner boundary.
