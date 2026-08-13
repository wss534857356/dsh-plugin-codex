# Architecture

The package owns one Harness LLM Service Provider. It relies on the existing `ctx.llm` Service Definition and Harness Agent loop Consumer; it does not introduce a second tool executor or persist model-visible state outside the session log.

For one call, the adapter resolves configuration, serializes the logged request, starts a managed Codex process through `ctx.subprocess`, validates every JSONL and structured-response field, requires the terminal `turn.completed` event, emits complete Harness blocks and usage, then tears the complete process tree down. Cancellation and timeout abort the same process signal but retain distinct Harness failure codes; request and cleanup failures are reported together without replacing the request code.

Codex runs in a newly created private temporary directory. The command is fixed except for validated model and reasoning identifiers, invokes the pinned npm CLI through `process.execPath`, reads the prompt from stdin, uses an ephemeral thread, disables startup update checks, analytics, native tool-bearing features, user configuration, and project rules, selects a read-only sandbox, and denies approvals. The subprocess service supplies a scrubbed parent environment; configuration may opt specific values such as `CODEX_HOME` back in.

The output schema has one object form because Codex `0.147.0` rejects top-level `oneOf`. It always carries `kind`, `text`, and `calls`; the plugin enforces the cross-field rules that JSON Schema cannot express on this path. Tool argument values are JSON-object strings so they remain byte-exact Harness `tool-call` arguments after validation.

This transport is deliberately stateless. Historical model output and tool results are serialized from the Harness request on every step, which preserves the repository's model-visible-equals-logged rule and keeps Harness authoritative for tool execution. The tradeoff is repeated context and Codex base-instruction overhead.
