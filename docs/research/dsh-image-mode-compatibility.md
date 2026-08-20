# DeepSeek Harness image-mode compatibility investigation (pre-implementation baseline)

- **Investigated:** 2026-08-20
- **Repositories:** plugin `E:\work\harness-plugin` at `296ae6f`; Harness `E:\work\deepseek-harness` at `141eb6fef8` (includes release commit `0.1.0-rc.8`)
- **Evidence rule:** local source, tests, documentation, and Git history only.
- **Status:** superseded by the implementation recorded in [ADR 0010](../adr/0010-bridge-durable-image-input.md).

> Historical scope: present-tense statements below describe plugin commit `296ae6f` before the rc.8 compatibility and multimodal implementation. They are retained as the investigation trail, not as claims about the current working tree.

## Implementation outcome (2026-08-21)

The implementation resolves the baseline findings:

- DSH dependencies, lockfile peer identities, `ReplayEnvelope`, attachment-limit fixtures, and the browser image renderer are aligned to rc.8. The custom Assistant renderer delegates consecutive images through `renderMessageImages` and no longer imports retired attachment atoms.
- Durable user images and image-bearing tool results are encoded as attachment markers, budgeted before reads, and hydrated only into the three pinned App Server transport vocabularies. Exact warm leases reserve before asynchronous hydration; supplied echoes are externalized without Assistant republication; native generated outputs still publish once.
- The dated catalog snapshot declares image input for the six observed routes and text-only input for Spark. Custom/unknown routes default to text-only, and the adapter enforces that declaration before process startup.
- Verification passed: clean frozen dependency installation, 117 unit/wire tests, server/client build and `0.1.17` package creation via `pnpm run check`, plus the authenticated cached-thread/tool/image round trip via `pnpm run test:e2e`.

The durable design decision is [ADR 0010](../adr/0010-bridge-durable-image-input.md); current operational behavior is documented in the root READMEs and architecture page.

## Executive finding

There are **two distinct image failures**:

1. **Generated-image output is persisted server-side but its browser renderer is incompatible with rc.8.** Harness moved attachment presentation behind `conversation.message.images`; this plugin still imports the removed `ImageGallery` package value and expects the retired `loadImage` owner prop.
2. **Vision/image input was never implemented.** The plugin explicitly advertises every Codex route as text-only and rejects every request-side Harness `ImageBlock`, while current Harness uses affirmative modality metadata to gate image admission and image-producing tools.

This is not one renamed field. A safe migration first aligns the client and replay contracts with rc.8, then implements durable Harness-reference → transient Codex image conversion (including tool results and request budgeting), and only after that advertises `inputModalities: ['text', 'image']` for routes whose current App Server catalog or explicit deployment configuration confirms image input.

## What changed in Harness

### 1. Model input modality became the capability protocol

Harness's adapter catalog type now carries `inputModalities`; absence means unknown, while an explicit list without `image` is a negative capability ([`packages/llm/llm/src/types.ts:232-244`](../../../deepseek-harness/packages/llm/llm/src/types.ts)). The service preserves this metadata from both catalog listing and exact model resolution ([`packages/llm/llm/src/index.ts:581-607`](../../../deepseek-harness/packages/llm/llm/src/index.ts), [`packages/llm/llm/src/index.ts:627-674`](../../../deepseek-harness/packages/llm/llm/src/index.ts)).

This field originated in multimodal Web work at commit `cb4c11b869f` (2026-07-23; confirmed by blame). Admission was hardened in `515d48875e5` (2026-07-30): the Host rejects an image prompt when the resolved model explicitly omits image support ([`packages/host/apiproxy/src/api-proxy.ts:2398-2410`](../../../deepseek-harness/packages/host/apiproxy/src/api-proxy.ts)). Model switching likewise refuses a text-only model when durable/pending history already contains images ([`packages/host/apiproxy/src/api-proxy.ts:2211-2221`](../../../deepseek-harness/packages/host/apiproxy/src/api-proxy.ts)).

The stricter tool-side rule is important: capabilities that can introduce images require an affirmative declaration, not “unknown.” `read_image` rejects routes whose resolved modalities are absent or omit `image` ([`packages/fs/tool-fs/src/read-image.ts:63-75`](../../../deepseek-harness/packages/fs/tool-fs/src/read-image.ts), introduced by `1861a3fc7ce`, 2026-08-10). MCP image results use the same affirmative gate ([`packages/mcp/mcp-client/src/tools.ts:405-419`](../../../deepseek-harness/packages/mcp/mcp-client/src/tools.ts), `49426cae02e`, 2026-08-11). ACP tests likewise model image-capable adapters by returning `['text', 'image']` ([`packages/acp/acp/tests/harness.ts:29-54`](../../../deepseek-harness/packages/acp/acp/tests/harness.ts)).

### 2. Replay metadata became an envelope

Current Harness defines terminal replay metadata as `ReplayEnvelope = { response, blocks? }`; `response` is adapter-private response state while optional `blocks` must align one-for-one with emitted blocks ([`packages/llm/llm/src/types.ts:283-323`](../../../deepseek-harness/packages/llm/llm/src/types.ts)). The assembler validates and prunes that alignment ([`packages/llm/llm/src/assembler.ts:129-148`](../../../deepseek-harness/packages/llm/llm/src/assembler.ts)).

The plugin still emits its `CodexReplayState` directly in each finish chunk ([`src/adapter.ts:201-207`](../../src/adapter.ts), [`src/adapter.ts:215-220`](../../src/adapter.ts)) and reads `message.source.replayState` as if it were that state directly ([`src/protocol.ts:157-169`](../../src/protocol.ts), [`src/protocol.ts:327-335`](../../src/protocol.ts)). This is a compile-time rc.8 mismatch and bypasses the new block-alignment contract at runtime. Migration must emit `{ response: codexReplayState }`, read `envelope.response`, and retain a decoder for already-persisted pre-envelope sessions.

This matters to image support because generated-image attachment markers live in replay state. Losing or misreading the envelope turns a cold rebuild into lossy fallback history exactly when the image bytes must be rehydrated.

### 3. Images are durable references, not inline provider payloads

The current LLM protocol represents an image block as `{ type: 'image', attachment: ImageAttachmentRef }` ([`packages/llm/llm/src/types.ts:65-75`](../../../deepseek-harness/packages/llm/llm/src/types.ts)). A reference includes the opaque id, verified media type, byte count, width, height, and optional display name ([`packages/attachment/attachment/src/types.ts:7-24`](../../../deepseek-harness/packages/attachment/attachment/src/types.ts)). Provider adapters must resolve stored bytes only at the provider boundary; they must not persist base64 in the session message.

Harness extended this projection across MCP (`49426cae02e`, 2026-08-11), Code Mode nested tool output (`e00146be73`, 2026-08-11), and ACP prompts/replies (`4f87c1fe6d`, 2026-08-11). The current MCP implementation admits decoded images as an ordered batch and emits durable image blocks ([`packages/mcp/mcp-client/src/tools.ts:472-477`](../../../deepseek-harness/packages/mcp/mcp-client/src/tools.ts)); ACP tests pin conversion between durable Harness blocks and ACP inline image content ([`packages/acp/acp/tests/turns.spec.ts:47-87`](../../../deepseek-harness/packages/acp/acp/tests/turns.spec.ts)).

### 4. Attachment admission gained batch and dimension contracts

Commit `219d2a1fb9` (2026-08-11) added ordered `AttachmentStore.saveImages`: it enforces count, aggregate bytes, supported media types, and validate-all-before-save behavior ([`packages/attachment/attachment/src/index.ts:39-83`](../../../deepseek-harness/packages/attachment/attachment/src/index.ts)). Commit `0e39055121` (2026-08-17) added `maxImageDimension` to `ImageAttachmentLimits` ([`packages/attachment/attachment/src/types.ts:26-35`](../../../deepseek-harness/packages/attachment/attachment/src/types.ts)) and made admission refuse an oversized width or height before the image can poison later provider requests. This landed in rc.8.

### 5. Attachment rendering moved from package values to slots

Commit `3e4ad10d05` (included after the plugin's rc.6 development baseline) changed `@deepseek-ai/dsh-client-ui-attachment` from exported React atoms into a dynamic client plugin. Its rc.8 root exports only a no-op host `apply` ([`packages/client/ui-attachment/src/index.ts:1-4`](../../../deepseek-harness/packages/client/ui-attachment/src/index.ts)); its client entry privately registers the `conversation.input.attachments` and `conversation.message.images` slots ([`packages/client/ui-attachment/src/client/index.ts:1-20`](../../../deepseek-harness/packages/client/ui-attachment/src/client/index.ts)). The conversation owner now hands chat-node renderers a `renderMessageImages` callback ([`packages/client/ui-conversation/src/client/contract/slots.ts:47-58`](../../../deepseek-harness/packages/client/ui-conversation/src/client/contract/slots.ts), [`packages/client/ui-conversation/src/client/contract/slots.ts:395-406`](../../../deepseek-harness/packages/client/ui-conversation/src/client/contract/slots.ts)); the stock Assistant renderer uses that callback instead of importing an attachment component ([`packages/client/ui-conversation/src/client/chat/AssistantMarkdown.tsx:68-89`](../../../deepseek-harness/packages/client/ui-conversation/src/client/chat/AssistantMarkdown.tsx)).

The plugin is still on the retired API: it imports `ImageGallery`, `ImageLoader`, and `MessageImageLabels` from the package root ([`src/client/CodexAssistantNodeView.tsx:1-5`](../../src/client/CodexAssistantNodeView.tsx)), renders `ImageGallery` directly ([`src/client/CodexAssistantNodeView.tsx:332-342`](../../src/client/CodexAssistantNodeView.tsx)), and expects `loadImage` on the chat-node owner ([`src/client/CodexAssistantNodeView.tsx:380-412`](../../src/client/CodexAssistantNodeView.tsx)). The client build deliberately externalizes that module ([`tsdown.config.ts:11-23`](../../tsdown.config.ts), [`tsdown.config.ts:56-59`](../../tsdown.config.ts)), so it cannot retain an rc.6 compatibility copy. Under rc.8, `ImageGallery` is absent and `loadImage` is no longer supplied; generated images can be durably saved by the host half yet fail in this custom renderer.

The fix is to remove the direct attachment imports and locale labels, accept `renderMessageImages`, and pass consecutive attachments through that callback. The host composition must include the stock `ui-attachment` client plugin; when it does not, the slot is intentionally empty just as it is for the stock renderer.

### 6. Command image submission gained an explicit envelope

The rc.8 command envelope now lets a command opt into images and carries serialized image attachments through submit/match/execute rather than treating the command line as the whole request ([`packages/client/ui-input-trigger/src/types.ts:51-81`](../../../deepseek-harness/packages/client/ui-input-trigger/src/types.ts), [`packages/interaction/commands/src/types.ts:12-24`](../../../deepseek-harness/packages/interaction/commands/src/types.ts), [`packages/interaction/commands/src/index.ts:315-395`](../../../deepseek-harness/packages/interaction/commands/src/index.ts)). The implementation series is `8d9fee19f9`, `4ed283a2ba`, `761d9d1978`, and `51fa8da8a3`, merged by `ba4aa807f6`. This plugin does not implement command interfaces, so no production change is directly required here; any future plugin-owned command or composer surface must use the canonical envelope rather than a legacy text-only call.

### 7. Providers now bound transient image requests

Commits `0b4a322003`, `28c2647293`, and `5849c57c0c` added/defaulted a `maxRequestImageBytes` budget (20 MiB) and deterministic transient offloading of oldest image occurrences ([`packages/llm/llm/src/content.ts:65-93`](../../../deepseek-harness/packages/llm/llm/src/content.ts), [`packages/llm/llm-deepseek/src/adapter.ts:96-104`](../../../deepseek-harness/packages/llm/llm-deepseek/src/adapter.ts)). Direct DeepSeek multimodal serialization (`7078918b30`, reviewed in `4a02791c9a`) is the first-party adapter example: it resolves durable refs only for a declared image-capable model and applies the request budget ([`packages/llm/llm-deepseek/src/serialize.ts:352-373`](../../../deepseek-harness/packages/llm/llm-deepseek/src/serialize.ts)).

For this plugin, budgeting must run over the **derived App Server history**, not only `GenerateOptions.messages`: provider replay snapshots can contain the model-visible generated-image `function_call_output.input_image` marker while the corresponding Assistant content is skipped in favor of replay. Count only image occurrences the hydration path will expand into provider input. Do not count or replace the duplicate `imageGeneration.result` marker retained for provider trajectory; current hydration expands only `function_call_output.input_image` ([`src/images.ts:325-336`](../../src/images.ts)). Budget those provider-visible fields before cache comparison and hydration. If adding a recent image replaces an older provider-visible marker with the standard omission text, the warm-history prefix changes and the lease must cold-rebuild; otherwise the live thread would retain an image the deterministic request says was offloaded.

The existing 4 MiB `maxJsonRpcLineBytes` default ([`src/index.ts:142-145`](../../src/index.ts)) is a separate inbound concern. It is enforced only on App Server stdout ([`src/wire.ts:139-172`](../../src/wire.ts)); outbound JSON-RPC writes currently have no line bound ([`src/wire.ts:221-225`](../../src/wire.ts)). A 3.5 MiB generated raster expands to about 4.67 MiB in base64 before notification overhead, so the inbound bound should be derived from the largest expected generated-image notification plus envelope headroom. The outbound `maxRequestImageBytes` policy independently bounds only the provider-visible payload hydrated into requests.

## Why this plugin fails the current contract

### Explicit text-only advertisement

The plugin's `modelInfo` unconditionally returns `inputModalities: ['text']` for configured models and fallback models ([`src/adapter.ts:63-70`](../../src/adapter.ts), [`src/adapter.ts:102-120`](../../src/adapter.ts)). This is not legacy ambiguity; under the current Harness semantics it is an explicit negative capability. The behavior dates to the plugin's initial commit `00f0801` and was never updated.

Neither `CodexModel` nor the public configuration exposes modalities ([`src/adapter.ts:37-45`](../../src/adapter.ts), [`src/index.ts:46-67`](../../src/index.ts)); the model schema and resolved mapping therefore cannot correct this per model ([`src/index.ts:128-150`](../../src/index.ts), [`src/index.ts:209-248`](../../src/index.ts)).

### Request images are rejected before Codex sees them

The request encoder throws `UNSUPPORTED_CONTENT` for an image at both fallback/tool-result conversion and top-level message conversion ([`src/protocol.ts:281-303`](../../src/protocol.ts), [`src/protocol.ts:320-380`](../../src/protocol.ts)). Thus merely changing catalog metadata would make Harness admit images only for the adapter to fail later; it would be a false capability claim.

### Output persistence exists, but rc.8 presentation is broken

The runner enables Codex native `image_generation` and `view_image` ([`src/runner.ts:27-56`](../../src/runner.ts), argv assembly at [`src/runner.ts:123-143`](../../src/runner.ts)). The host half decodes native output, saves it through the attachment service, emits a standard Harness image block, and replaces replay bytes with a durable marker ([`src/images.ts:166-238`](../../src/images.ts), [`src/images.ts:241-323`](../../src/images.ts), integrated at [`src/adapter.ts:146-191`](../../src/adapter.ts)). This was added by plugin commits `63f9ebb` and `944aa00`.

That server-side bridge remains valuable, but the retired direct-`ImageGallery` client path prevents it from being an rc.8 end-to-end success. Even after the slot migration restores generated-image display, editing an attached image, using Harness `read_image`, forwarding MCP/ACP image results, or continuing a conversation whose model-visible history contains an image still require the missing request-side bridge and modality declaration.

### Release skew

The plugin develops against rc.6 packages and peers rc.5 ([`package.json:65-96`](../../package.json)), whereas the inspected Harness is rc.8. A dependency bump exposes at least three concrete mismatches: the removed attachment atoms/changed chat-node owner props, the new `ReplayEnvelope`, and `ImageAttachmentLimits.maxImageDimension`. Plugin test doubles still omit that dimension field (for example [`tests/images.spec.ts:19-30`](../../tests/images.spec.ts) and [`tests/adapter.spec.ts:354-364`](../../tests/adapter.spec.ts)), even though production receives the real limits object from `ctx.attachments` ([`src/index.ts:265-275`](../../src/index.ts)).

## What the pinned Codex protocol supports

The official pinned `@openai/codex@0.147.0` binary can generate its own protocol bindings:

```powershell
pnpm exec codex app-server generate-ts --experimental --out .tmp/codex-schema
```

Those generated bindings define:

- warm `turn/start.input` as `UserInput[]`, including `{ type: 'image', url: string, detail? }`;
- cold `thread/inject_items` as raw Responses items, whose message content includes `{ type: 'input_image', image_url: string, detail? }`;
- dynamic-tool callback results with `{ type: 'inputImage', imageUrl: string }`; and
- each App Server model descriptor with `inputModalities: ('text' | 'image' | 'audio')[]`.

A direct `initialize` + `model/list` query on 2026-08-20 used the active logged-in Windows x86_64 Codex profile, App Server user-agent version `0.147.0`, `includeHidden: false`, and `limit: 100`. It observed:

| Observed App Server model | Observed input modalities |
|---|---|
| `gpt-5.6-sol` | `text, image` |
| `gpt-5.6-terra` | `text, image` |
| `gpt-5.6-luna` | `text, image` |
| `gpt-5.5` | `text, image` |
| `gpt-5.4` | `text, image` |
| `gpt-5.4-mini` | `text, image` |
| `gpt-5.3-codex-spark` | `text` |

The package version pins the **protocol shape**, not this server/account-driven catalog. Model availability and modalities can change with account or rollout state, so this table is dated evidence rather than a permanent capability promise. A shipped static snapshot must record and re-run this probe whenever Codex is upgraded; a dynamic catalog path should cache `model/list` and still treat an unavailable, undeclared, or custom route as text-only unless configuration confirms otherwise.

The transport can therefore carry images and the observed catalog exposed six candidate routes, but the plugin remains the missing bridge. For a warm exact continuation, hydrate only the appended message into v2 `text`/`image` inputs. For a cold reconstruction, hydrate marker-bearing Responses `input_image` content. A Harness tool result needs both forms: marker-bearing `function_call_output` for durable/cold history and camel-case `inputImage` content for the pending live callback.

## Exact compatibility work needed

1. **Land an rc.8 compatibility baseline without claiming image input.**
   - Raise DSH peer/dev dependencies together, regenerate the lockfile/build artifacts, and run typecheck/tests against the same release as the host.
   - Migrate the custom Assistant renderer from direct `ImageGallery`/`loadImage` use to the owner's `renderMessageImages` callback. Remove the obsolete attachment UI imports and labels.
   - Wrap new replay state as `{ response: CodexReplayState }`; accept both the envelope and the old direct state when reconstructing existing sessions.
   - Add `maxImageDimension` to every attachment-limit fixture and add an oversized-side rejection test.
   - This baseline should restore generated-image presentation while remaining honestly text-only for requests.

2. **Create a synchronous durable App Server history form.**
   - Encode one ordered Responses `message.content` array for each user message: `input_text` entries plus `input_image` entries whose `image_url` is a versioned `ImageAttachmentRef` marker, never base64.
   - Encode image-bearing Harness tool results as marker-bearing `function_call_output` arrays instead of flattening them to text. Reject unsupported system/foreign-assistant image roles explicitly.
   - Keep this marker form as mapper baseline and cache identity. It remains small, serializable, deterministic, and safe to compare.

3. **Budget model-visible marker history before any read.**
   - Add `maxRequestImageBytes` (20 MiB default, validated positive) and replace the oldest **hydrated `input_image` occurrences** with the shared omission text until their projected base64 length fits.
   - Include user, Harness-tool-result, and generated-output `function_call_output.input_image` fields. Exclude `imageGeneration.result` and every other trajectory-only marker so one image is not double-counted or its audit record corrupted.
   - Store/compare the budgeted model-visible history in the lease so a changed offload prefix forces a cold rebuild.
   - Independently derive the inbound stdout frame bound from the largest expected generated-image notification; do not equate it with the aggregate outbound request budget.

4. **Hydrate only at the App Server boundary.**
   - Generalize `NativeImageBridge` into a bidirectional image bridge: strict marker parsing, `ctx.attachments.readImage(ref, signal)`, integrity/ref verification, memoized data URLs, and no data URL in logs/replay.
   - Cold path: hydrate marker-bearing Responses history for `thread/inject_items`.
   - Warm user path: detect one appended marker message, hydrate only it, and translate to v2 `{type:'text'}`/`{type:'image', url}` for `turn/start.input`.
   - Warm tool path: keep marker history for matching but hydrate callback content to v2 `inputText`/`inputImage`.
   - Externalize App Server echoes of supplied images back to the same markers without publishing them as new Assistant images. Keep generated-image publication occurrence-aware so its raw echo still deduplicates.

5. **Advertise only confirmed current modalities after conversion works.**
   - Add `inputModalities?: ('text' | 'image')[]` to `Config.models` and `CodexModel`, validate non-empty/allowed/no-duplicate values, and return it from both `listModels` and `resolveModel`.
   - If retaining a static catalog, snapshot the six image-capable observations above with the query date/version and re-probe on each Codex upgrade. Prefer a cached runtime `model/list` source when its lifecycle cost is acceptable.
   - Keep the observed text-only Spark route, custom entries without an explicit declaration, unavailable catalog entries, and uncatalogued fallback ids at `['text']`.
   - Update `cordis.patch.yml` and both READMEs. Do **not** ship this metadata before steps 2–4.

6. **Add vertical compatibility tests before release.**
   - rc.8 client build plus renderer test proving images route through `conversation.message.images`.
   - Replay-envelope migration from old direct version-4 state and new enveloped state.
   - Catalog/exact-resolution tests for the observed snapshot, a changed runtime catalog, Spark, configured text-only routes, unavailable entries, and unknown ids.
   - Mixed text/image ordering, image-only prompt, nested tool-result image, missing/corrupt attachment, cancellation, and request-budget offloading without reading omitted bytes.
   - Cold replay and warm user/tool continuation with no inline base64 in replay state, action snapshots, or durable messages.
   - Native generation followed by image editing/viewing, verifying one output image block, no supplied-image republish, and no duplicate provider echo.
   - Host-composition coverage against rc.8 proving Web admission and `read_image`/MCP routing see affirmative capability.

## Recommended sequencing

Use two releasable checkpoints:

1. **Compatibility hotfix:** rc.8 dependencies + slot-based image rendering + replay envelope + updated fixtures, still text-only.
2. **Multimodal vertical slice:** marker history + budgeting + cold/warm/tool hydration + echo externalization + truthful per-model modalities + host integration tests.

This keeps generated-image output repair small and safe while preventing a premature modality flag from moving failure downstream into `appServerHistory`.
