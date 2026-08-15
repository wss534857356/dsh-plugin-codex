# App Server provider investigation

## Goal

Determine whether the locally authenticated Codex App Server can act as a Harness-owned main-model provider. Harness must own the client instruction layer, durable conversation, tool catalog, tool execution, permissions, and session presentation; the Codex process must only authenticate, carry requests, and stream model events.

The proof boundary is the decoded request emitted by the pinned Codex client. The plugin cannot replace or inspect OpenAI service-side policies and does not claim to do so. The investigation failed its prompt-ownership gate before implementation.

## Required invariants

1. The outbound base instructions equal the Harness `GenerateOptions.system` string exactly.
2. No user Codex configuration, project instruction file, collaboration mode, personality, skill, plugin, MCP server, or built-in Codex instruction contributes client-controlled behavioral text.
3. Every history item sent to Codex is reconstructed from logged Harness messages.
4. The model-facing tool catalog equals the Harness `GenerateOptions.tools` catalog, and only the Harness agent loop executes requested tools.
5. Reasoning summaries, assistant text, tool calls, usage, cancellation, and failures are converted to Harness stream events as they occur.
6. A Codex-native action remains provider-owned. Its lifecycle and outcome are logged and displayed as `codex-action` content blocks, never as Harness tool calls.
7. A request and its Codex process tree leave no provider thread, temporary workspace, or child process after completion, handoff, cancellation, timeout, or failure.

## Request lifecycle

Each Harness model request gets one managed App Server subprocess and one ephemeral thread. Keeping requests stateless makes the Harness session log authoritative and prevents provider history from diverging from replayed history.

1. Start the pinned Codex App Server with controllable user configuration effects overridden, unrelated optional native integrations disabled, stable image generation and image viewing enabled for the native `imagegen` skill, analytics disabled, and a private empty working directory. Keep Code Mode available because `gpt-5.6-sol` uses it for dynamic tools.
2. Complete the App Server initialization handshake with the experimental API capability required by dynamic tools.
3. Start an ephemeral thread with:
   - `baseInstructions` set to the exact Harness system prompt;
   - `developerInstructions` set to the empty string;
   - `personality` set to `none`;
   - no collaboration mode;
   - dynamic tools derived from Harness tool schemas under the Harness namespace, with the Harness skill loader mapped and bounded to its logged session catalog;
   - read-only, never-approve execution policy as defense in depth.
4. Emit a lifecycle-category `thread/start` report containing the returned `instructionSources`; a non-empty report is disclosure, not failure and the report is not classified as a model action.
5. Inject all user, assistant, tool-call, and tool-result history as native protocol items derived from the Harness request, then start an empty turn because the current user message is already in that logged history.
6. Map reasoning summary and assistant-message deltas directly to indexed Harness blocks; classify raw input echoes, Codex-owned context, and new provider outputs before producing replay state or trajectory.
7. On a dynamic tool request, emit validated Harness tool-call blocks, end the model step with `tool-calls`, interrupt the Codex turn, and tear down the process. Harness executes and logs the tools; the next request reconstructs their results from the session.
8. On successful turn completion, emit usage followed by the terminal finish chunk and tear down the process.

The dynamic-tool handoff is a phase gate. The proof must show that a pending App Server server request can be surfaced and interrupted without executing a tool or leaking a process. If the pinned protocol cannot satisfy that behavior, the change requires a new interactive-provider capability in Harness rather than an adapter-side tool executor.

## Prompt ownership proof

A keyless integration test runs the official pinned App Server against a local fake Responses-compatible endpoint and captures the decoded outbound request. The test uses hostile inputs so absence is meaningful:

- a Codex config developer instruction containing a unique sentinel;
- a project `AGENTS.md` containing a different sentinel;
- a non-default personality or collaboration instruction sentinel;
- a configured native MCP tool sentinel;
- a Harness system prompt and Harness tool with their own sentinels.

The test requires exact equality for outbound instructions, exact equality for the tool catalog, native role-preserving history, and absence of every hostile sentinel. This test is the prompt-ownership acceptance gate; a model response is not proof because instruction following is nondeterministic.

Runtime checks complement the capture test:

- `instructionSources` must be valid JSON and is logged in the provider trajectory;
- every dynamic call must carry the Harness namespace, name an offered mapped tool, and carry object-valued JSON arguments; the mapped Harness skill loader also requires a current catalog entry;
- only the documented reasoning, assistant-message, dynamic-tool, usage, and lifecycle events are accepted;
- native action items become provider-owned trajectory blocks and never generate Harness tool execution events;
- the installed Codex version and generated protocol schema must match the pinned baseline.

## Result

The pinned App Server cannot satisfy invariants 1, 2, or 4 for `gpt-5.6-sol`; invariant 6 remains an implementation obligation under the layered design.

The keyless test applies every protocol-level isolation control available in Codex `0.147.0`: a fresh home and workspace, explicit base and empty developer instructions, no personality or collaboration mode, empty environment and capability roots, disabled native features, disabled discovered skills, read-only execution, and denied approvals. `thread/start` reports no `instructionSources`, yet the outbound Responses request still contains:

- the Harness base prompt as only one developer message;
- Codex-owned permission, primary-agent, multi-agent, and environment-context messages after it;
- a Codex `functions.exec` tool layer that includes the Harness dynamic tool together with Codex plan and skills tools;
- Codex interaction and collaboration tools that were not declared by Harness.

For a generic model family, App Server places the Harness base prompt in top-level `instructions`, but still adds permission and environment messages plus plan, interaction, skills, and web-search tools. Model selection therefore changes the encoding but does not establish Harness-only ownership.

`baseInstructions`, `developerInstructions`, `dynamicTools`, and empty `instructionSources` are insufficient evidence for an exact client request. App Server has no documented raw-model mode or field that suppresses these remaining additions.

No implementation stage follows automatically. The product decision must choose one of these foundations:

1. Preserve prompt ownership by adding a direct Responses API provider backed by an API key.
2. Preserve local Codex login by accepting a layered provider in which Codex co-owns instructions and tools.
3. Keep the current `codex exec` bridge until Codex exposes a documented raw transport that passes the capture gate.

## Selected foundation

The product decision selects option 2: preserve the local Codex login and implement a layered App Server provider. ADR 0002 records the accepted ownership split.

The prompt-ownership invariants remain documented as disproven properties rather than being weakened or relabeled. Implementation acceptance now requires:

1. Harness history and the current user input are reconstructed only from the Harness request.
2. Harness tools are declared as namespaced App Server dynamic tools, the Harness skill loader uses its catalog-bounded mapped name, and only the Harness agent loop executes validated callbacks.
3. Codex-added prompt and tool layers remain disclosed in documentation and covered by the wire characterization test.
4. Every Codex-native action lifecycle, including raw Code Mode calls without a `ThreadItem` pair, is emitted as provider-owned `codex-action` trajectory and never represented as a Harness tool call.
5. Reasoning, text, Harness dynamic-tool requests, usage, cancellation, and failures are emitted as live Harness stream events.
6. Every model-visible Harness input and every provider output needed for replay is present in the Harness session log.
7. App Server processes, ephemeral threads, and temporary workspaces are settled after every terminal path.
8. Native generated images are durable Harness attachments, appear through the standard image block, and leave no inline base64 in action or replay records.

## Acceptance scenarios

1. A text-only request displays reasoning and text before turn completion.
2. A file-context request displays a Harness read/search call, its logged result, and the final answer in order.
3. Hostile configurable developer instructions are overridden, project instructions are excluded by the private working directory, and remaining Codex-owned prompt and tool layers stay characterized and disclosed.
4. A native Codex action appears in the transcript with its category, Codex action type, exact protocol event, lifecycle phase, input, and available outcome, without appearing in the Harness tool-call stream; a failed native action does not fail an otherwise completed turn.
5. Abort, timeout, malformed JSON-RPC, App Server exit, and tool handoff leave no process tree or temporary workspace.
6. A real local-OAuth Harness run completes a two-step tool round trip and produces a keyless replayable session snapshot.
7. The packed tarball passes isolated profile installation and the actual web profile renders the same trajectory after restart.
8. A native image-generation turn emits one durable Harness image, and cold replay restores the provider image from its attachment marker without republishing it.

## Delivery stages

Each completed stage is committed after its own checks pass.

1. `docs: record App Server provider design`
2. `test: characterize App Server prompt ownership`
3. `docs: accept layered App Server ownership`
4. `feat: stream Codex App Server model events`
5. `test: cover Harness-owned Codex tool round trips`
6. Final package verification and installation use the resulting clean commit; profile installation and service restart do not modify this repository.

## Verification evidence

The keyless wire test runs the pinned CLI against a local Responses endpoint and proves both history injection through an empty turn and the remaining Codex-owned layers. The assembled Harness snapshot fixes the transcript distinction between `codex-action` trajectory and Harness `tool-call` blocks across two model steps. Mapper tests prove injected history is filtered, Codex-owned context is logged but not reinjected, raw Code Mode call/output pairs are visible, and failed native actions do not fail completed turns. The real local-OAuth test completes the same two-step dynamic-tool round trip through App Server and verifies both process trees have exited.
