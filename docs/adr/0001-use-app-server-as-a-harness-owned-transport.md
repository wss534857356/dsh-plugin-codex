---
status: accepted
---

# Use Codex App Server as a Harness-owned transport

Replace the `codex exec` structured-output bridge with the pinned Codex App Server protocol. Harness remains the only agent runtime: it supplies the client instruction layer and durable history, executes every tool through its agent loop, and records every model-visible input and output; Codex supplies local OAuth and model event transport only.

## Considered Options

- Keep `codex exec` and put the Harness request in one user prompt. This cannot prove prompt ownership, exposes no live trajectory before process completion, and asks the model to simulate function calling through a response schema.
- Expose the native Codex agent and mirror its actions into Harness. This creates a second tool executor whose permissions, context, and durable state are not owned by the Harness session.
- Use App Server base instructions, native history items, streamed events, and host-owned dynamic tool declarations. This provides protocol fields and events that can be verified at the outbound request while preserving Harness tool execution.

## Consequences

The integration pins the Codex CLI and generated App Server schema, starts an ephemeral Codex thread for each Harness model request, rejects Codex-native actions, and treats protocol upgrades as reviewed migrations. Prompt ownership is guaranteed only through the client request sent by Codex; OpenAI service-side policies are not replaceable or inspectable by the plugin.
