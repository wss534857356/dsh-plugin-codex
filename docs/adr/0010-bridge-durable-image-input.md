---
status: accepted
---

# Bridge durable Harness images at App Server boundaries

Harness messages remain authoritative for image input. Store each image only as an `ImageAttachmentRef` and place a versioned attachment marker in the adapter's derived Responses history wherever App Server expects an image URL. Never store a data URL in a Harness message, replay envelope, Codex trajectory block, or session-thread watermark.

Apply the request image budget to marker fields that will actually be hydrated into model-visible input: user-message `input_image` content and `function_call_output.input_image` content. Compute projected base64 length from durable byte metadata, replace the oldest occurrences with Harness's standard omission text until the request fits, and perform this conversion before reading attachments. Do not count or rewrite duplicate `imageGeneration.result` trajectory markers. Compare and commit the budgeted marker history so a newly offloaded prefix invalidates a warm lease and cold-reconstructs truthfully.

Hydrate attachments only at one of three explicit transport boundaries:

- cold `thread/inject_items`: Responses `input_image.image_url`;
- exact warm `turn/start.input`: App Server v2 `image.url`;
- exact pending dynamic-tool callback: `inputImage.imageUrl`.

A warm continuation reads only its appended user message or matching tool result; it never rehydrates the complete history. Missing, corrupt, mismatched, or cancelled attachment reads fail the request and retire the affected lease.

Use distinct supplied and published image ownership. Externalize App Server echoes of Harness-supplied images back to their markers without emitting Assistant image blocks. A newly generated native image is validated and committed through `ctx.attachments`, emitted once as a standard Harness image block, and deduplicated when its raw output echo arrives.

Advertise image input only for a configured model whose current catalog snapshot or explicit deployment configuration affirms it. The shipped App Server `0.147.0` snapshot records image input for GPT-5.6 Sol/Terra/Luna, GPT-5.5, GPT-5.4, and GPT-5.4 Mini, and text-only input for GPT-5.3 Codex Spark. Custom entries without `inputModalities` and uncatalogued model ids remain text-only. Re-probe `model/list` whenever the pinned Codex version changes because the account/server catalog is not pinned by the npm package.

This keeps attachment storage, model capability, provider transport, replay, and browser presentation under their existing owners while making image-only prompts, mixed prompts, `read_image`, and image-bearing Harness tool results reconstructible across warm continuation, cold restart, fork, and compaction.
