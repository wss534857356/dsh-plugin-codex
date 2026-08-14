---
status: accepted
---

# Use App Server as a layered Codex provider

Replace the `codex exec` bridge with pinned Codex `0.147.0` App Server after explicitly accepting Codex as a co-owner of the model-visible prompt and tool catalog. Harness remains authoritative for durable history, Harness dynamic-tool execution, session logging, and UI trajectory; the provider discloses Codex-added layers and records Codex-native action lifecycles as provider-owned trajectory instead of presenting them as Harness tool calls.

## Considered Options

- Use a direct Responses API provider. This preserves exact prompt and tool ownership but requires API credentials instead of the existing local Codex login.
- Keep `codex exec`. This preserves the existing OAuth bridge but buffers trajectory and simulates Harness tool calls through structured output.
- Use App Server as if it were a raw model transport. The outbound wire proof in ADR 0001 rejects this claim.

## Consequences

The provider can reuse the local Codex OAuth session and stream App Server events, but its documentation and diagnostics must never claim prompt ownership. Harness tools are supplied as App Server dynamic tools; their requests are handed back to the Harness agent loop and are never executed inside the provider. Code Mode remains enabled because `gpt-5.6-sol` uses it to dispatch dynamic tools. Shell, file, web, MCP, collaboration, and other Codex-native action events remain owned by Codex: each lifecycle snapshot is logged as a distinct `codex-action` content block and displayed in Harness without producing `tool/call` or `tool/result` events.
