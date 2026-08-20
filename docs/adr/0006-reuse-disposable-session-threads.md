---
status: accepted
---

# Reuse disposable App Server threads per Harness session

Reuse one live ephemeral Codex App Server thread for consecutive conversation requests carrying the same Harness `sessionId` and request epoch. The Harness session log and each fully assembled `GenerateOptions` request remain authoritative; the live thread is a disposable transport cache that may be destroyed without losing the ability to issue the request again.

## State ownership

One session lease owns one App Server process, one thread, the exact Harness-derived history synchronized into that thread, at most one pending dynamic-tool callback, and its cleanup. No runner-wide flag duplicates those states. The lease has three protocol states: idle, running one Codex turn, or waiting for one Harness tool result. A request for the same session while another request is actively consuming the lease fails instead of creating two writers.

The cache epoch covers every thread-level value that can change model behavior or invalidate the tool callback catalog: Codex/App Server version, model provider, model, reasoning effort, Harness system text, dynamic-tool declarations, and the fixed permission and feature configuration. An epoch change disposes the old lease and starts a cold thread. A Harness compaction replacement, fork, repaired session, retry, or any other history that is not the exact expected continuation also starts cold from the complete assembled request.

Cold reconstruction injects the complete logged history into a new thread and starts an empty turn. An append-only batch of ordinary user messages keeps the thread warm: the first message uses `turn/start.input`, and additional messages use ordered `turn/steer` requests against that turn. `thread/inject_items` remains a reconstruction mechanism rather than the normal warm-turn transport because a real two-turn OAuth probe demonstrated cache reuse when only the cold history was injected, while injecting the second user message produced no new cache hit.

When Codex requests a declared Harness dynamic tool, the adapter emits the normal Harness `tool-call` and leaves the App Server JSON-RPC request pending. The next request may resume that Codex turn when its derived history is the expected prefix followed by the matching `function_call_output` and then zero or more ordinary user messages. The lease replies with that logged result, steers each following message into the active turn in order, and Codex continues the same turn. A replacement, reordering, another tool result, or any unsupported history disposes the lease and reconstructs a new thread instead of guessing how to merge state.

Successful output advances the lease's expected history from the same replay items written to the Harness assistant message. Cancellation, transport failure, malformed output, consumer abandonment, or an unrecognized state transition disposes the lease. The App Server process raises `model_auto_compact_token_limit` to Harness's safe integer ceiling so Harness compaction can replace logged history first. Native Codex compaction may still finish the active Codex turn, but it makes the lease ineligible for another Harness request: opaque native compaction state is provider trajectory, not a portable Harness checkpoint. Harness compaction remains the durable history-replacement mechanism and naturally forces a cold thread from its logged summary.

Calls without `sessionId` and auxiliary calls keep the one-shot path. Session disposal, plugin unload, configurable idle expiry, and configurable least-recently-used capacity eviction close listeners before terminating the process tree and await quiescence. Threads stay `ephemeral: true`; the plugin does not resume Codex rollout files after process or application restart.

## Evidence

The [Codex configuration reference](https://developers.openai.com/codex/config-reference/) defines `model_auto_compact_token_limit` as the token threshold that triggers automatic history compaction. A raw App Server `0.147.0` OAuth probe held an `item/tool/call` server request, supplied its result later, completed the same Codex turn, and then started a second turn on the same ephemeral thread with `model_auto_compact_token_limit=9007199254740991`. The second turn reported `cachedInputTokens: 4864`, and both turns reported an effective model context window of `258400`. The equivalent tool callback also completed when the first user history was injected and the turn used empty input, but injecting the second user message produced no new cache read on that request. The protocol exposes all operations required by the lease without changing Harness AgentLoop: `GenerateOptions.sessionId`, `thread/start`, `turn/start`, bidirectional `item/tool/call`, `turn/interrupt`, and the existing `session/disposed` lifecycle.

## Considered Options

- Keep one process and thread per model step. This keeps lifecycle code small but repeatedly rebuilds Codex-owned prompt layers, did not produce cache reads in the observed Harness session, and multiplies replay input until Harness compaction replaces it.
- Persist Codex threads and resume them by thread id. This can preserve a warm rollout across application restarts, but makes an external mutable store part of recovery and introduces collision, deletion, migration, and reconciliation rules that a disposable cache does not need.
- Run one shared App Server daemon for every Harness session. This reduces process count but requires event multiplexing, per-thread cancellation isolation, daemon ownership, and recovery from one shared failure. A bounded process-per-session lease maps each process tree to one owner and keeps teardown local.
- Inject every newly logged item before an empty turn. This preserves the existing stateless encoder but did not demonstrate cross-turn cache reuse. Injection is limited to cold reconstruction; native `turn/start.input` and `turn/steer` carry append-only warm user messages, and every non-prefix continuation falls back to cold reconstruction.
- Let native Codex compaction become the durable checkpoint. App Server exposes opaque encrypted compaction items without a portable Harness replacement range or summarization result, so the session log could not reconstruct the same continuation independently.

## Consequences

Normal consecutive turns and Harness tool loops reuse Codex's provider cache without turning the plugin into a second Agent implementation. The common path avoids full-history reinjection, while every unusual prefix or lifecycle event pays a cold-start cost rather than adding reconciliation branches. One active cached session consumes one App Server process, so deployments must choose bounded capacity and idle expiry appropriate to their host. Token usage for a Codex turn that spans several Harness tool steps arrives when that native turn completes and is attributed to the completing Harness step.
