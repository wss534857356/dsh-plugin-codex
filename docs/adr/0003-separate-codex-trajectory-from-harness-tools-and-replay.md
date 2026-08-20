---
status: accepted
---

# Separate Codex trajectory from Harness tools and replay

Classify every raw App Server response item against the exact history injected for the current stateless request. Known history echoes produce no new event. Codex-added developer, system, and user messages become context-category `codex-action` reports and remain in replay metadata for audit, but are not reinjected. New assistant and provider output items remain in lossless replay. Non-message raw items that are not declared Harness tool calls become action-category reports, including Code Mode call and output items that have no App Server `ThreadItem` lifecycle.

Reserve Harness `tool-call` blocks for validated App Server `item/tool/call` server requests in the Harness-owned namespace and naming tools declared by the current Harness request. A raw call with the same ownership label and declared name is retained for replay but does not also become a Codex action report. Keep a Code Mode `custom_tool_call` or `custom_tool_call_output` in reconstructible replay only when the same replay step contains its mate: a fresh Code Mode host cannot resume a suspended invocation, while the canonical Harness function call and result preserve a callback that crossed the Harness tool loop. Each Codex report carries its category, phase, exact protocol event, and original JSON snapshot. Native action phases such as `failed` and `declined` describe provider trajectory and do not fail the Harness request unless App Server reports that the turn itself failed. [ADR 0007](0007-namespace-harness-dynamic-tools.md) defines the namespace rule.

## Considered Options

- Display only App Server `ThreadItem` lifecycles. This loses raw Code Mode calls and outcomes because the pinned protocol can emit them only as `rawResponseItem/completed`.
- Store all raw items in replay without displaying them. This preserves future model input but hides Codex-owned context and action execution from the Harness transcript.
- Reinject every raw item. This duplicates Harness history and Codex-owned context on each stateless step and makes the request grow recursively.
- Convert raw native calls into Harness tool calls. This assigns execution and failure semantics to the wrong runtime.

## Consequences

Replay state uses an explicit version; unrecognized state falls back to logged Harness message reconstruction. The transcript can contain lifecycle and context reports even when the model performs no native action, so `thread/start` alone must not be read as an action trace. Context snapshots increase log volume, but they make the Codex-added model input inspectable. The generic Harness renderer can display the complete block immediately; the dedicated client renderer presents the same fields compactly without changing durable data.
