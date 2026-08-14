---
status: accepted
---

# Render Codex trajectory in the browser plugin

Ship a browser entry from the same out-of-tree package and register an `assistant-step` renderer at priority `-10`. Harness's stock renderer remains registered at priority `0`; the lower-priority cell wins while this plugin is active and the stock renderer resumes when it is removed.

The renderer preserves text Markdown, reasoning disclosure, image galleries, grouped Harness tool-call omission, interruption status, and the generic JSON fallback. It validates an opaque custom block before treating it as `codex-action`. A recognized record uses Harness's compact disclosure row and state dot for its semantic category, interpreted action type, and phase. Expanding the row reveals the exact protocol event, action id, and complete record through Harness's JSON tree. `thread/start` states that prompt ownership is layered and reports the discovered instruction-source count. Failed or declined native actions remain action states and do not become Harness request errors.

## Considered Options

- Keep the generic JSON renderer. The durable data remains complete, but the UI calls a known provider record unknown and does not communicate action semantics.
- Modify Harness's `AssistantMarkdown` directly. This gives one host package knowledge of an out-of-tree provider and breaks the standalone installation requirement.
- Add a new conversation node for each action. The provider currently records actions inside the durable Assistant message; a second node would duplicate them unless the host event model changed.
- Convert the records to text or reasoning blocks. This discards structured presentation intent and makes provider trajectory look assistant-authored.

## Consequences

The package has both Host and browser artifacts and declares the browser plugin in `dsh.client`. Because the current Harness exposes the Assistant row as a keyed cell rather than each custom content block as a child slot, the plugin must render all Assistant block kinds while it is active. Focused tests pin the preserved fallback and the `codex-action` specialization. The shadow depends on the public `assistant-step` payload and slot priority APIs; a future per-content-block slot can replace the broader renderer without changing logged records.
