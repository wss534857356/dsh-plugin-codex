# dsh-llm-codex-app-server

`dsh-llm-codex-app-server` registers a DeepSeek Harness main-model provider backed by the locally authenticated Codex App Server. It is an out-of-tree Harness bundle, so installing it does not modify the `deepseek-harness` repository.

This differs from Harness's built-in `@deepseek-ai/dsh-subagent-codex`. The built-in package exposes Codex as a delegated child Agent. This package registers on `ctx.llm`, so `codex-local` is a selectable provider for the Harness Agent loop.

## How it works

An ordinary Harness conversation session reuses one pinned `@openai/codex@0.147.0` App Server in a private empty directory and one ephemeral thread while its bounded cache lease remains valid. The process uses the native Codex account state under `CODEX_HOME`; the plugin never reads, copies, logs, or stores OAuth tokens or API keys. Requests without a session id and auxiliary requests remain one-shot.

The adapter supplies the Harness system text as App Server base instructions, reconstructs cold threads by injecting all logged Harness messages before an empty turn, declares Harness tools under the `deepseek_harness` App Server namespace, and sends later ordinary user messages through native turn input. The outer Harness `skill` tool is exposed there as `harness_skill`; its argument schema accepts only names from the current Harness session catalog, while Codex-native skills stay on Codex's own loader. A warm thread is reused only when the complete request is the exact expected continuation; otherwise it is discarded and rebuilt. App Server still adds Codex-owned instructions and tools. This is deliberately a layered provider, not a raw-model transport or a claim that Harness replaces the Codex prompt.

Reasoning, assistant text, usage, Codex-owned context, diagnostics, and action lifecycles are converted to Harness stream events as they arrive. Codex cached input is reported through Harness `cacheReadTokens`, so the standard token meter and conversation statistics display the cache-hit percentage without provider-specific UI. Each `codex-action` block carries a `category` (`lifecycle`, `context`, `action`, or `diagnostic`), the parsed `phase`, the exact `protocolEvent`, and its JSON protocol snapshot. Raw Code Mode calls and outcomes are included even when App Server emits no corresponding `ThreadItem`. A failed or declined Codex-native action remains an action outcome and does not fail the Harness model request unless App Server reports that the turn itself failed.

Completed Codex-native image outputs are decoded and committed through Harness's durable attachment service before their stream events are published. The adapter emits a standard Harness `image` block for preview and download, while action snapshots and replay state retain only a small attachment marker. Cold reconstruction verifies the attachment and restores its data URL only in the in-memory App Server request; warm session continuation compares the marker without reading the image. A chat attachment is not an implicit workspace mutation: producing `public/example.png` or another project file still requires Codex to request a declared Harness mutation tool with an explicit destination.

The package also ships a browser plugin. It shadows the stock Assistant cell at a lower slot priority, preserves the standard text, reasoning, image, and generic fallback presentations, and renders `codex-action` blocks with Harness's compact disclosure row and state dot. The collapsed row shows the interpreted action, category, and phase; expanding it reveals the summary, exact protocol event, action id, and the durable JSON record in Harness's JSON tree. `thread/start` explicitly reports layered prompt ownership and discovered instruction-source count; it is not labeled as a Harness tool or request failure.

The `thread/start` block is provider lifecycle disclosure, not evidence that the model performed a native action. Codex-added developer, system, and user messages that are not part of injected Harness history appear as `context/injected` reports. They remain logged for audit but are not fed back as Harness-authored history on the next stateless request.

When App Server requests a declared tool in the `deepseek_harness` namespace, the adapter emits a real Harness `tool-call`, ends that model step, and leaves the App Server callback pending. Namespace and mapped name must both match before the call crosses into Harness; `harness_skill` additionally requires an exact current Harness catalog name and maps back to `skill` only after validation. An unnamespaced Codex-native call remains provider trajectory even when its name resembles a Harness tool; only a validated namespaced Harness call is hidden from the native-action presentation. Harness owns execution, approval, presentation, and durable logging for those calls. An exact next request replies with the logged tool result and continues the same Codex turn; a mismatch forces a cold reconstruction.

## Install

Authenticate the native CLI once:

```sh
codex login
```

Build and pack this checkout:

```sh
pnpm install
pnpm run check
```

Install the generated tarball into a Harness profile:

```sh
dsh plugin --profile web add ./dist/dsh-llm-codex-app-server-0.1.14.tgz
dsh --profile web --dump-config
dsh --profile web
```

The bundle registers provider `codex-local` and every model shown by the pinned App Server's default picker: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`. Select one in the Models UI. Installation does not replace the profile's default model automatically. App Server routes marked as hidden are not added to the selector.

Harness profiles set `autoInstallPeers: false`, so installation may report missing peer dependencies. At boot, the profile module fallback supplies those peers from the current Harness installation so the plugin shares its Cordis and service instances.

For source installation, use `dsh plugin --profile web add github:<owner>/<repo>#<commit>`. The package's `prepare` script builds TypeScript during a Git install, so pnpm must allow that package build. A packed tarball or npm release is already built.

## Configuration

Later profile patch layers can replace the `llm-codex-app-server` row. A replacement must restate the complete config because Harness patch rows do not deep-merge.

| Key | Default | Meaning |
|---|---:|---|
| `provider` | `codex-local` | Harness provider route. |
| `displayName` | `Codex (local login)` | Selector label. |
| `modelProvider` | `openai` | Codex App Server model-provider id. |
| `models` | Seven visible App Server catalog entries | Advisory model metadata and reasoning choices for the pinned App Server. Unlisted safe model ids remain routable. |
| `timeoutMs` | `300000` | Wall-clock limit for one App Server turn. |
| `disposeGraceMs` | `3000` | Process-tree termination grace. |
| `maxJsonRpcLineBytes` | `4194304` | Maximum bytes accepted for one newline-delimited App Server JSON-RPC message. Parsed messages do not count toward a cumulative stdout limit. |
| `maxStderrBytes` | `65536` | Maximum retained diagnostic output. |
| `maxRetries` | `0` | Harness-visible retries for transient process or provider failures. |
| `maxCachedSessions` | `8` | Maximum idle or tool-waiting session leases retained before least-recently-used eviction. Active requests may temporarily exceed it. |
| `sessionIdleTimeoutMs` | `600000` | Idle lifetime of a cached App Server session thread. |
| `env` | `{}` | Explicit child environment layered over Harness's scrubbed parent environment. Use this to pass `CODEX_HOME` when it is nonstandard. |

Example override:

```yaml
- id: llm-codex-app-server
  name: dsh-llm-codex-app-server
  config:
    provider: codex-local
    displayName: Codex (local login)
    modelProvider: openai
    models:
      - id: gpt-5.6-sol
        name: GPT-5.6-Sol
        contextWindow: 1050000
        reasoningEfforts: [low, medium, high, xhigh, max, ultra]
        defaultReasoningEffort: low
    timeoutMs: 600000
    disposeGraceMs: 3000
    maxJsonRpcLineBytes: 4194304
    maxStderrBytes: 65536
    maxRetries: 0
    maxCachedSessions: 8
    sessionIdleTimeoutMs: 600000
    env:
      CODEX_HOME: !!js process.env.CODEX_HOME
```

## Compatibility and limitations

- The protocol baseline is Codex CLI `0.147.0`; the dependency and runtime handshake are pinned because the experimental App Server protocol is version-sensitive.
- The default catalog exposes each model's full context window: `1050000` for GPT-5.4, GPT-5.5, and the GPT-5.6 family; `400000` for `gpt-5.4-mini`; and `128000` for `gpt-5.3-codex-spark`. The pinned App Server may report a smaller effective working window in usage notifications. A deployment that enforces that smaller limit can override model metadata; a provider-confirmed context overflow remains eligible for Harness compaction and retry.
- The default model catalog contains the seven non-hidden routes returned by `model/list` for the pinned App Server `0.147.0`. Hidden work-mode and automatic-review routes remain manually routable but are excluded from the user selector.
- Codex co-owns the model-visible instructions and tool catalog. The keyless wire test records the extra permission, primary-agent, collaboration, environment, interaction, and code-mode layers that remain after supported thread overrides.
- Code Mode remains enabled because `gpt-5.6-sol` uses it to dispatch App Server dynamic tools. Codex-native image generation and image viewing remain enabled so Codex's `imagegen` skill retains its required tools; unrelated optional native integrations remain disabled.
- Native generated images require the profile's durable `ctx.attachments` service. Image bytes are subject to that service's media, byte, count, and pixel limits and are never stored inline in `codex-action` blocks or replay state.
- Native Codex actions may still occur. They run in a private empty working directory under a read-only sandbox with approvals set to `never`; their lifecycle snapshots are displayed as provider trajectory, and approval or interaction requests are safely declined unless the protocol can answer them without user authority.
- Discovered instruction sources are shown in the `thread/start` lifecycle report. A non-empty report is disclosure, not a request failure. Codex-generated context that is absent from this list is reported separately as `context/injected`.
- The provider accepts text input. Image input is rejected before process startup.
- `temperature`, `maxTokens`, and `stop` are rejected because this App Server path does not expose reliable equivalents. Auxiliary calls that require `maxTokens`, including LLM-backed session titles and basic compaction, cannot use this provider.
- App Server automatic compaction is configured at Harness's safe integer ceiling so Harness can replace logged history first. Any native compaction item or notification still makes the live lease non-reusable and is never written into reconstructible replay state. Basic compaction must use a summarization provider that supports its `maxTokens` requirement.
- `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=deepseek-harness` identifies adapter requests; this internal compatibility point is reverified on Codex upgrades.
- Session-scoped threads are in-memory disposable caches. The Harness log and adapter replay state reconstruct model-visible history after process restart, plugin reload, expiry, eviction, compaction, fork, repair, retry mismatch, or any changed request epoch; Codex rollout files are never resumed.
- Replay state version `4` contains only provider outputs in `items`; observed Codex-owned context is retained separately in `contextItems` for audit and never reinjected. Native image outputs use durable attachment markers and are hydrated only for a cold App Server injection. Harness calls retain their `deepseek_harness` namespace and mapped App Server name during reconstruction. Reconstruction coalesces cumulative snapshots by stable provider item or call identity, so sessions written by older plugin versions do not multiply the same opaque outputs on later requests. Older replay versions fall back to Harness message reconstruction.
- Authentication and subscription availability belong to the native Codex installation. Login failures surface as Harness `AUTH` failures; the plugin provides no credential UI.

## Development

The raw-transport claim was rejected in [ADR 0001](docs/adr/0001-use-app-server-as-a-harness-owned-transport.md) after the [provider investigation](docs/app-server-provider-plan.md) captured Codex-owned instructions and tools on the outbound request. [ADR 0002](docs/adr/0002-use-app-server-as-a-layered-codex-provider.md) accepts the implemented ownership split. [ADR 0003](docs/adr/0003-separate-codex-trajectory-from-harness-tools-and-replay.md) records how raw actions, provider context, replay, and Harness tool calls remain distinct. [ADR 0004](docs/adr/0004-render-codex-trajectory-in-the-browser-plugin.md) records the client renderer shadow used by the out-of-tree bundle. [ADR 0005](docs/adr/0005-coalesce-stateless-codex-replay.md) bounds cold replay reconstruction by provider identity. [ADR 0006](docs/adr/0006-reuse-disposable-session-threads.md) defines exact session continuation and disposable cache ownership. [ADR 0007](docs/adr/0007-namespace-harness-dynamic-tools.md) makes the App Server namespace the tool-ownership label. [ADR 0008](docs/adr/0008-retain-native-image-tools.md) keeps the native image tools required by Codex's image skill. [ADR 0009](docs/adr/0009-externalize-native-generated-images.md) records durable image projection and replay hydration.

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm pack --pack-destination dist
```

Unit and wire tests require no account. With `codex login` already completed, run the real local-login round trip:

```sh
pnpm run test:e2e
```

The real test loads the Harness LLM and local-subprocess providers, completes a Harness tool round trip and ordinary follow-up on one cached App Server thread, requires a non-zero provider cache read, and verifies process-tree quiescence after plugin disposal.
