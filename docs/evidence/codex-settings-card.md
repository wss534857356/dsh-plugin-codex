# Codex settings card — CDP evidence

Captured against the locally installed `dsh-llm-codex-app-server@0.1.19`
through Microsoft Edge DevTools Protocol 1.3.

The CDP run reloaded `http://127.0.0.1:3080`, then clicked **设置 → 插件 →
插件配置 → Codex App Server** and expanded the card. It also issued
`settings.describe` from the page and recorded the redacted
`llm-codex-app-server` namespace.

![Expanded Codex App Server settings card](../images/codex-settings-card.png)

## Result

| Check | Result |
|---|---|
| DSH root response | HTTP 200 |
| Plugin client entry | `client.js?rev=e6dc7736b496`, HTTP 200 |
| Settings namespace | `llm-codex-app-server`, `applies: live` |
| Image generation switch | Present and enabled |
| Codex Web Search takeover | Present and enabled |
| Web Search model | Present; persisted user override shown |
| Web Search result cap | Present; effective value `8` |
| Browser console/runtime errors | `0` |
| Failed network requests | `0` |

The screenshot is cropped to the settings dialog, excluding the workspace and
session list. The settings response is the API's redacted descriptor and
contains no credential values.

The complete machine-readable CDP action, DOM, network, console, settings, and
assertion log is in [codex-settings-card-cdp.json](codex-settings-card-cdp.json).
The PNG SHA-256 recorded by that run is
`4b76587fb1e922326017d0dc13e22a5d46bfac84ccaa2cd40a5f66be27e71c24`.
