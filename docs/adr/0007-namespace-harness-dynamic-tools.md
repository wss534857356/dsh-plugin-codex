---
status: accepted
---

# Namespace Harness dynamic tools before callback routing

Expose every Harness tool through one Codex App Server dynamic-tool namespace named `deepseek_harness`. Preserve ordinary tool names inside it, but expose the Harness `skill` tool as `harness_skill`. Include that alias only when the logged Harness session catalog contains entries, and constrain its `name` argument to those exact entries. Treat an `item/tool/call` as a Harness handoff only when its namespace and mapped name belong to the catalog supplied for that model request; restore `harness_skill` to `skill` only after validating its requested catalog entry. Preserve the namespace and mapped name on reconstructed `function_call` items. Suppress a raw native-action report only when both fields establish Harness ownership.

Codex-owned tools remain outside that namespace. Codex-native skill instructions and the outer Harness catalog can both tell the model to load a skill, so the distinct `harness_skill` name prevents the two loaders from sharing an exact Code Mode identifier. A native skill absent from the Harness session catalog cannot satisfy the alias schema or invoke the Harness skill registry. If App Server sends an unexpected unnamespaced or foreign-namespaced callback, the plugin rejects that JSON-RPC request, reports it as a Codex action, and continues to classify model-request success from the terminal turn status.

App Server's [dynamic-tool protocol](https://developers.openai.com/codex/app-server/#dynamic-tools) provides namespace declarations and returns the selected namespace in each callback. The protocol field identifies ownership before arguments are interpreted. The `harness_skill` mapping then distinguishes two semantically different loaders, while the catalog enum restricts its existing functional argument rather than adding a model-generated ownership flag.

## Considered Options

- Keep all Harness tools at the top level and decide ownership by name. A native and Harness tool can share a name, so this can route a Codex-native `skill` request into the Harness skill catalog or hide its trajectory.
- Namespace only the Harness `skill` tool. Other current or future collisions, including planning and search tools, would retain the same ambiguity.
- Keep `skill` unchanged inside the Harness namespace. Code Mode exposes the namespace and function name together, but both Codex and Harness instructions still refer to a loader named `skill`; a distinct mapped name makes the intended catalog explicit.
- Remove the Harness skill tool from this provider. Codex-native skills would be unambiguous, but sessions could not use skills contributed only by the outer Harness composition.
- Add an ownership field to tool arguments. Tool arguments belong to each tool's functional input and arrive after the runtime has selected a tool; they are not a reliable dispatch label.

## Consequences

Harness tools remain ordinary Harness tools after the callback crosses the adapter: their logged names, execution, approvals, and UI use the existing Harness structures. Harness-only skills remain available through the mapped loader; Codex-native skills remain `codex-action` trajectory and are never presented as failed Harness tool requests. The dynamic-tool declaration participates in the session cache epoch, so a catalog or mapping change reconstructs live leases. Replay state version `3` rejects older provider state without the mapped skill name and rebuilds tool history from the authoritative Harness log.
