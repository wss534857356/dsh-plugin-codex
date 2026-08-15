---
status: accepted
---

# Namespace Harness dynamic tools before callback routing

Expose every Harness tool through one Codex App Server dynamic-tool namespace named `deepseek_harness`. Treat an `item/tool/call` as a Harness handoff only when its namespace equals `deepseek_harness` and its tool name belongs to the catalog supplied for that model request. Preserve the namespace on reconstructed `function_call` items. Suppress a raw native-action report only when both the namespace and declared name establish Harness ownership.

Codex-owned tools remain outside that namespace. An unnamespaced native call therefore remains provider trajectory when its name collides with a Harness tool such as `skill`; it cannot invoke the Harness skill registry. If App Server sends an unexpected unnamespaced or foreign-namespaced callback, the plugin rejects that JSON-RPC request, reports it as a Codex action, and continues to classify model-request success from the terminal turn status.

App Server's [dynamic-tool protocol](https://developers.openai.com/codex/app-server/#dynamic-tools) provides namespace declarations and returns the selected namespace in each callback. The protocol field identifies ownership before arguments are interpreted. An argument flag would modify every Harness tool schema, depend on model-generated arguments, and still leave raw response-item presentation unable to determine ownership consistently.

## Considered Options

- Keep all Harness tools at the top level and decide ownership by name. A native and Harness tool can share a name, so this can route a Codex-native `skill` request into the Harness skill catalog or hide its trajectory.
- Namespace only the Harness `skill` tool. Other current or future collisions, including planning and search tools, would retain the same ambiguity.
- Add an ownership field to tool arguments. Tool arguments belong to each tool's functional input and arrive after the runtime has selected a tool; they are not a reliable dispatch label.

## Consequences

Harness tools remain ordinary Harness tools after the callback crosses the adapter: their logged names, execution, approvals, and UI use the existing Harness structures. Codex-native calls remain `codex-action` trajectory and are never presented as failed Harness tool requests. The dynamic-tool declaration participates in the session cache epoch, so the namespace change reconstructs live leases. Replay state version `2` rejects older unnamespaced provider state and rebuilds tool history from the authoritative Harness log.
