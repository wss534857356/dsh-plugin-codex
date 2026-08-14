# dsh-llm-codex-exec

`dsh-llm-codex-exec` registers a DeepSeek Harness main-model provider backed by the locally authenticated Codex CLI. It is an out-of-tree Harness bundle: installing it does not modify the `deepseek-harness` repository.

This is different from Harness's built-in `@deepseek-ai/dsh-subagent-codex`. The built-in package exposes Codex as a delegated child Agent. This package registers on `ctx.llm`, so `codex-local` appears as a selectable provider for the Harness Agent loop.

## How it works

Every Harness model request starts one pinned `@openai/codex@0.147.0` `codex exec --json --ephemeral` process. The process uses the native Codex account state under `CODEX_HOME`; the plugin never reads, copies, logs, or stores OAuth tokens or API keys.

The adapter serializes the Harness system prompt, durable messages, and tool schemas into one deterministic JSON request. Codex returns a schema-constrained object containing either a final assistant message or Harness tool calls. The adapter maps that object to `StreamChunk`s. Tool calls are executed by Harness and their logged results return in the next request; Codex-native tools are disabled and the child runs in an empty private directory with a read-only sandbox and `approval_policy="never"`.

The CLI emits its final response only after the turn completes, so the adapter exposes complete blocks rather than live token deltas.

## Install

First authenticate the native CLI once:

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
dsh plugin --profile web add ./dist/dsh-llm-codex-exec-0.1.0.tgz
dsh --profile web --dump-config
dsh --profile web
```

The bundle registers provider `codex-local` and model `gpt-5.6-sol`. Select it in the Models UI. It does not replace the profile's default model automatically.

The install may report missing peer dependencies because Harness profiles deliberately set `autoInstallPeers: false`. At boot, the profile module fallback supplies those peers from the current Harness installation so the plugin shares its Cordis and service instances.

For source installation, use `dsh plugin --profile web add github:<owner>/<repo>#<commit>`. The package's `prepare` script builds TypeScript during a Git install, so pnpm requires the profile to allow that package build. A packed tarball or npm release is prebuilt and needs no install-time build permission.

## Configuration

Later profile patch layers can replace the `llm-codex-exec` row. A replacement must restate the complete config because Harness patch rows do not deep-merge.

| Key | Default | Meaning |
|---|---:|---|
| `provider` | `codex-local` | Harness provider route. |
| `displayName` | `Codex (local login)` | Selector label. |
| `models` | GPT-5.6 Sol catalog entry | Advisory model metadata and reasoning choices. Unlisted CLI-safe model ids remain routable. |
| `timeoutMs` | `300000` | Wall-clock limit for one CLI turn. |
| `disposeGraceMs` | `3000` | Process-tree termination grace. |
| `maxStdoutBytes` | `4194304` | Maximum retained Codex JSONL output. |
| `maxStderrBytes` | `65536` | Maximum retained diagnostic output. |
| `maxRetries` | `0` | Harness-visible retries for transient process/provider failures. |
| `env` | `{}` | Explicit child environment layered over Harness's credential-scrubbed parent environment. Use this to pass `CODEX_HOME` when it is nonstandard. |

Example override:

```yaml
- id: llm-codex-exec
  name: dsh-llm-codex-exec
  config:
    provider: codex-local
    displayName: Codex (local login)
    models:
      - id: gpt-5.6-sol
        name: GPT-5.6 Sol
        contextWindow: 272000
        reasoningEfforts: [low, medium, high, xhigh, max, ultra]
        defaultReasoningEffort: low
    timeoutMs: 600000
    disposeGraceMs: 3000
    maxStdoutBytes: 4194304
    maxStderrBytes: 65536
    maxRetries: 0
    env:
      CODEX_HOME: !!js process.env.CODEX_HOME
```

## Compatibility and limitations

- The verified protocol baseline is Codex CLI `0.147.0`; the dependency is pinned because JSONL events, feature names, the output-schema subset, and the internal originator override are not a stable standalone LLM API.
- This is an experimental bridge over a complete coding Agent, not a native token-streaming API. Codex's own base instructions remain part of each request and add substantial token overhead.
- The bridge supports text, reasoning history, and Harness tool calls. Image input is rejected before process startup.
- `temperature`, `maxTokens`, and `stop` are rejected because this CLI path cannot represent them reliably. Auxiliary calls that require `maxTokens`, including LLM-backed session titles and basic compaction, cannot use this provider.
- `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=deepseek-harness` identifies requests from the adapter, but the variable is an internal Codex compatibility point and must be reverified on upgrades.
- Each request uses a fresh ephemeral Codex thread. Context is reconstructed from the Harness session log; there is no native thread resume or provider replay state.
- Authentication and subscription availability belong to the native Codex installation. Login failures surface as Harness `AUTH` failures; this plugin provides no credential UI.

## Development

The App Server replacement was rejected in [ADR 0001](docs/adr/0001-use-app-server-as-a-harness-owned-transport.md) after the [provider investigation](docs/app-server-provider-plan.md) captured Codex-owned instructions and tools on the outbound model request despite all supported isolation controls. The current implementation remains the disclosed `codex exec` bridge; adopting App Server now requires an explicit decision to accept Codex as a co-owner of prompts and tools.

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm pack --pack-destination dist
```

Unit tests use no account. With `codex login` already completed, run the real local-login smoke directly:

```sh
pnpm run test:e2e
```

It loads the real Harness LLM and local-subprocess providers, performs one Harness-owned tool round trip over two fresh Codex processes, and verifies both process trees have exited. Before release, also install the packed tarball into an isolated profile and run one headless task with `agent-default-model` set to `codex-local`.
