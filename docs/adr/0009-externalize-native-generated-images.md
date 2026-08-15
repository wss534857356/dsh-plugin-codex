---
status: accepted
---

# Externalize Codex-native generated images

Codex App Server reports one generated image in two provider events: the completed `imageGeneration` item carries raw base64, and the corresponding `function_call_output` carries a base64 data URL for model-visible replay. Persisting those events unchanged duplicates a multi-megabyte payload across streamed blocks, the final Assistant message, and replay state while producing no Harness image attachment.

Decode each supported native image before publishing its event and commit the verified bytes through `ctx.attachments`. Emit the returned reference as one standard Harness `image` block. Replace the binary field in both provider records with a versioned `dsh-image-attachment` marker containing only the durable `ImageAttachmentRef`. Replay state version `4` owns this representation.

Cold reconstruction reads and verifies each referenced attachment, restores the provider data URL in memory, and injects that transient value into App Server. Warm session continuation compares the externalized history and does not read or encode image bytes. A provider echo of an image already present in durable history does not emit another Harness image block.

Attachment media, byte, count, aggregate-byte, and pixel limits apply before a provider image can reach the Session Log. Missing attachment storage, malformed base64, unsupported media, invalid markers, missing objects, and integrity failures stop the model request instead of recording an incomplete image result.

The attachment is a durable conversation artifact with the standard Harness preview and download behavior. The provider adapter does not infer a workspace destination or silently create a project file. Materializing an image as `public/example.png` or another repository path requires a declared Harness mutation tool and an explicit destination.
