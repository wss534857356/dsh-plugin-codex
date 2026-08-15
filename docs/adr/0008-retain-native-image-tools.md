---
status: accepted
---

# Retain Codex-native image tools

Explicitly enable the stable Codex `image_generation` and `view_image` features in the App Server process. The native `imagegen` skill depends on those tools; loading its instructions without them produces a misleading API-key fallback even when the local Codex account provides built-in image generation.

These tools remain Codex-owned. Their activity is reported as `codex-action` trajectory unless App Server requests a separately declared Harness dynamic tool. The Harness skill alias does not proxy or relabel them.

The private working directory, read-only sandbox, never-approve policy, and existing handling for native actions continue to apply. Unrelated optional native integrations remain disabled.
