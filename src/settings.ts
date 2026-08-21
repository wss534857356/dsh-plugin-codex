/** User-editable Codex capability settings exposed through DSH settings. */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SAFE_MODEL_ID } from './identifiers.ts'

/** Settings address shared by the Host section and the browser card. */
export const CODEX_SETTINGS_NAMESPACE = settingsNamespace('llm-codex-app-server')

/** The focused capability subset that may change without reloading the provider. */
export interface CodexCapabilitySettings {
  /** Offer Codex's pinned native image-generation capability on ordinary model turns. */
  imageGenerationEnabled?: boolean
  /** Let this provider take over Harness `web_search` calls made by its own agents. */
  webSearchEnabled?: boolean
  /** Search-only Codex model; blank or absent follows the initiating main model. */
  webSearchModel?: string
  /** Maximum merged source count returned by one Harness `web_search` call. */
  webSearchMaxResults?: number
}

/** Shared fields used by both the plugin composition schema and settings section. */
export const codexCapabilitySettingsFields = {
  imageGenerationEnabled: z.boolean().default(true),
  webSearchEnabled: z.boolean().default(true),
  webSearchModel: z.string(),
  webSearchMaxResults: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8),
}

/** Settings-service schema rendered and persisted for the Codex capability card. */
export const CodexCapabilitySettingsSchema: z<CodexCapabilitySettings> = z.object(
  codexCapabilitySettingsFields,
)

/** One validated snapshot used for an operation or App Server process. */
export interface ResolvedCodexCapabilitySettings {
  readonly imageGenerationEnabled: boolean
  readonly webSearchEnabled: boolean
  readonly webSearchModel?: string
  readonly webSearchMaxResults: number
}

/** Resolve defaults and constraints that programmatic callers can bypass in the schema. */
export function resolveCodexCapabilitySettings(
  settings: CodexCapabilitySettings,
): ResolvedCodexCapabilitySettings {
  const model = settings.webSearchModel?.trim()
  if (model !== undefined && model.length > 0 && !SAFE_MODEL_ID.test(model)) {
    throw new Error('llm-codex-app-server: webSearchModel is not a safe Codex model id')
  }
  const maxResults = settings.webSearchMaxResults ?? 8
  if (!Number.isSafeInteger(maxResults) || maxResults <= 0) {
    throw new Error('llm-codex-app-server: webSearchMaxResults must be a positive safe integer')
  }
  return {
    imageGenerationEnabled: settings.imageGenerationEnabled ?? true,
    webSearchEnabled: settings.webSearchEnabled ?? true,
    ...(model === undefined || model.length === 0 ? {} : { webSearchModel: model }),
    webSearchMaxResults: maxResults,
  }
}
