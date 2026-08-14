---
status: rejected
---

# Use Codex App Server as a Harness-owned transport

Do not replace the `codex exec` bridge with Codex App Server when prompt ownership is required. App Server is an agent runtime, not a raw authenticated model transport: its host-supplied `baseInstructions` and `dynamicTools` coexist with Codex-owned instructions, context, and tools in the model request.

## Considered Options

- Keep `codex exec` and put the Harness request in one user prompt. This cannot prove prompt ownership, exposes no live trajectory before process completion, and asks the model to simulate function calling through a response schema.
- Expose the native Codex agent and mirror its actions into Harness. This creates a second tool executor whose permissions, context, and durable state are not owned by the Harness session.
- Use App Server base instructions, native history items, streamed events, and host-owned dynamic tool declarations. This provides useful protocol fields and events, but it does not make Harness the sole owner of model-visible instructions or tools.
- Call the OpenAI Responses API directly. This can preserve exact request ownership, but it requires API credentials and does not reuse the local Codex subscription login through a documented interface.

## Evidence

The keyless wire test starts the pinned Codex `0.147.0` App Server with a fresh `CODEX_HOME`, an empty working directory, an explicit empty `developerInstructions`, personality `none`, no environment or capability roots, and every relevant feature disabled. It also disables every skill returned by `skills/list`, verifies that `instructionSources` is empty, and captures the decoded request at a local Responses-compatible endpoint.

For the configured `gpt-5.6-sol` model, the captured request still contains Codex permission instructions, primary-agent and multi-agent instructions, an environment-context message, and Codex-owned `exec`, plan, interaction, skills, and collaboration tools. The Harness base instruction is one developer message rather than the entire instruction layer, and the Harness dynamic tool is routed through Codex's tool runtime alongside those native tools. Empty `instructionSources` therefore proves only that no discoverable instruction file was loaded; it does not prove prompt ownership.

## Consequences

The current `codex exec` implementation remains an explicitly experimental bridge and continues to disclose that Codex's own base instructions are present. No App Server implementation should be added under the Harness-only ownership claim. A future implementation requires either a documented upstream raw-transport mode whose outbound request passes the same wire test, direct API credentials, or an explicit product decision to accept Codex as a co-owner of prompts and tools.
