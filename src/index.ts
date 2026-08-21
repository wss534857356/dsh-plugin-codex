/** DeepSeek Harness main-model provider backed by the locally authenticated Codex App Server. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { CodexAppServerAdapter } from './adapter.ts'
import type { CodexModel } from './adapter.ts'
import { SAFE_MODEL_ID, SAFE_REASONING_EFFORT } from './identifiers.ts'
import { CodexAppServerRunner } from './runner.ts'
import {
  CODEX_SETTINGS_NAMESPACE,
  codexCapabilitySettingsFields,
  CodexCapabilitySettingsSchema,
  resolveCodexCapabilitySettings,
} from './settings.ts'
import type { CodexCapabilitySettings, ResolvedCodexCapabilitySettings } from './settings.ts'
import { CodexWebSearchProvider } from './web-search.ts'

export { CodexAppServerAdapter } from './adapter.ts'
export type { CodexAdapterOptions, CodexModel } from './adapter.ts'
export { boundRequestImageHistory, imageAttachmentMarker, NativeImageBridge } from './images.ts'
export type { CodexImageStorePort, ExternalizedCodexEvent } from './images.ts'
export {
  AppServerEventMapper,
  appServerDynamicTools,
  appServerHistory,
  assertCompletedTurn,
  codexFailureCode,
  harnessToolCall,
} from './protocol.ts'
export type { CodexActionBlock, CodexReplayState, HarnessToolCall } from './protocol.ts'
export {
  CODEX_APP_SERVER_VERSION,
  CodexAppServerRunner,
  codexAppServerArgv,
  codexCliEntry,
} from './runner.ts'
export type {
  CodexAppServerEvent,
  CodexAppServerHydratedToolResult,
  CodexAppServerRequest,
  CodexAppServerRunnerOptions,
  CodexAppServerRunnerPort,
  CodexAppServerThreadPort,
  CodexAppServerThreadRequest,
  CodexAppServerToolResult,
  CodexAppServerTurnRequest,
  JsonValue,
} from './runner.ts'
export { CodexWebSearchProvider } from './web-search.ts'
export type { CodexSearchTarget, CodexWebSearchProviderOptions } from './web-search.ts'
export {
  CODEX_SETTINGS_NAMESPACE,
  CodexCapabilitySettingsSchema,
  resolveCodexCapabilitySettings,
} from './settings.ts'
export type { CodexCapabilitySettings, ResolvedCodexCapabilitySettings } from './settings.ts'

export const name = 'llm-codex-app-server'
export const inject = ['llm', 'subprocess', 'tools']

/** Plugin configuration for one static provider route. */
export interface Config extends CodexCapabilitySettings {
  provider?: string
  displayName?: string
  modelProvider?: string
  models?: Array<{
    id: string
    name?: string
    description?: string
    contextWindow?: number
    inputModalities?: ModelModality[]
    reasoningEfforts?: string[]
    defaultReasoningEffort?: string
  }>
  timeoutMs?: number
  disposeGraceMs?: number
  maxJsonRpcLineBytes?: number
  maxRequestImageBytes?: number
  maxStderrBytes?: number
  maxRetries?: number
  maxCachedSessions?: number
  sessionIdleTimeoutMs?: number
  env?: Record<string, string>
}

const MODEL_MODALITIES = ['text', 'image'] as const

const DEFAULT_MODELS = [
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    contextWindow: 1_050_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoningEffort: 'low',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model for everyday work.',
    contextWindow: 1_050_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6-Luna',
    description: 'Fast and affordable agentic coding model.',
    contextWindow: 1_050_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
    contextWindow: 1_050_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    description: 'Strong model for everyday coding.',
    contextWindow: 1_050_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4-Mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    contextWindow: 400_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3-Codex-Spark',
    description: 'Ultra-fast coding model.',
    contextWindow: 128_000,
    inputModalities: ['text'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
  },
] satisfies Array<Required<NonNullable<Config['models']>[number]>>

const DEFAULT_MAX_JSON_RPC_LINE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

const modelSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
  reasoningEfforts: z.array(z.string()),
  defaultReasoningEffort: z.string(),
})

export const Config: z<Config> = z.object({
  provider: z.string().default('codex-local'),
  displayName: z.string().default('Codex (local login)'),
  modelProvider: z.string().default('openai'),
  models: z.array(modelSchema).default(DEFAULT_MODELS),
  timeoutMs: z.number().max(2_147_483_647).default(300_000),
  disposeGraceMs: z.number().max(2_147_483_647).default(3_000),
  maxJsonRpcLineBytes: z.number().step(1).min(1).default(DEFAULT_MAX_JSON_RPC_LINE_BYTES),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  maxStderrBytes: z.number().step(1).min(1).default(64 * 1024),
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  maxCachedSessions: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8),
  sessionIdleTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(600_000),
  ...codexCapabilitySettingsFields,
  env: z.dict(z.string()).default({}),
})

interface ResolvedConfig {
  readonly provider: string
  readonly displayName: string
  readonly modelProvider: string
  readonly models: readonly CodexModel[]
  readonly timeoutMs: number
  readonly disposeGraceMs: number
  readonly maxJsonRpcLineBytes: number
  readonly maxRequestImageBytes: number
  readonly maxStderrBytes: number
  readonly maxRetries: number
  readonly maxCachedSessions: number
  readonly sessionIdleTimeoutMs: number
  readonly capabilities: ResolvedCodexCapabilitySettings
  readonly env: Readonly<Record<string, string>>
}

const SAFE_ROUTE = /^[a-z0-9][a-z0-9._-]{0,79}$/u

function resolveConfig(config: Config): ResolvedConfig {
  const provider = config.provider ?? 'codex-local'
  const displayName = config.displayName ?? 'Codex (local login)'
  const modelProvider = config.modelProvider ?? 'openai'
  const timeoutMs = config.timeoutMs ?? 300_000
  const disposeGraceMs = config.disposeGraceMs ?? 3_000
  const maxJsonRpcLineBytes = config.maxJsonRpcLineBytes ?? DEFAULT_MAX_JSON_RPC_LINE_BYTES
  const maxRequestImageBytes = config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  const maxStderrBytes = config.maxStderrBytes ?? 64 * 1024
  const maxRetries = config.maxRetries ?? 0
  const maxCachedSessions = config.maxCachedSessions ?? 8
  const sessionIdleTimeoutMs = config.sessionIdleTimeoutMs ?? 600_000
  const capabilities = resolveCodexCapabilitySettings(config)
  const env = config.env ?? {}
  if (!SAFE_ROUTE.test(provider)) throw new Error('llm-codex-app-server: provider is not a safe route id')
  if (displayName.trim().length === 0) throw new Error('llm-codex-app-server: displayName must not be empty')
  if (!SAFE_ROUTE.test(modelProvider)) {
    throw new Error('llm-codex-app-server: modelProvider is not a safe Codex provider id')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('llm-codex-app-server: timeoutMs must be a positive finite number')
  }
  if (!Number.isFinite(disposeGraceMs) || disposeGraceMs <= 0 || disposeGraceMs > 2_147_483_647) {
    throw new Error('llm-codex-app-server: disposeGraceMs must be a positive finite number')
  }
  if (!Number.isSafeInteger(maxJsonRpcLineBytes) || maxJsonRpcLineBytes <= 0) {
    throw new Error('llm-codex-app-server: maxJsonRpcLineBytes must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
    throw new Error('llm-codex-app-server: maxRequestImageBytes must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxStderrBytes) || maxStderrBytes <= 0) {
    throw new Error('llm-codex-app-server: maxStderrBytes must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error('llm-codex-app-server: maxRetries must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(maxCachedSessions) || maxCachedSessions <= 0) {
    throw new Error('llm-codex-app-server: maxCachedSessions must be a positive safe integer')
  }
  if (!Number.isSafeInteger(sessionIdleTimeoutMs)
    || sessionIdleTimeoutMs <= 0
    || sessionIdleTimeoutMs > 2_147_483_647) {
    throw new Error('llm-codex-app-server: sessionIdleTimeoutMs must be a positive timer duration')
  }
  const configuredModels = config.models ?? DEFAULT_MODELS
  if (configuredModels.length === 0) throw new Error('llm-codex-app-server: models must not be empty')
  const seen = new Set<string>()
  const models = configuredModels.map((candidate): CodexModel => {
    if (!SAFE_MODEL_ID.test(candidate.id) || seen.has(candidate.id)) {
      throw new Error(`llm-codex-app-server: invalid or duplicate model id ${JSON.stringify(candidate.id)}`)
    }
    seen.add(candidate.id)
    const inputModalities = [...(candidate.inputModalities ?? ['text'])]
    if (inputModalities.length === 0
      || inputModalities.some(modality => !MODEL_MODALITIES.includes(modality))
      || new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(`llm-codex-app-server: model ${JSON.stringify(candidate.id)} has invalid inputModalities`)
    }
    const efforts = [...(candidate.reasoningEfforts ?? [])]
    if (efforts.some(effort => !SAFE_REASONING_EFFORT.test(effort)) || new Set(efforts).size !== efforts.length) {
      throw new Error(`llm-codex-app-server: model ${JSON.stringify(candidate.id)} has invalid reasoningEfforts`)
    }
    if (candidate.defaultReasoningEffort !== undefined && !efforts.includes(candidate.defaultReasoningEffort)) {
      throw new Error(`llm-codex-app-server: model ${JSON.stringify(candidate.id)} default reasoning effort is not advertised`)
    }
    return {
      id: candidate.id,
      name: candidate.name ?? candidate.id,
      ...(candidate.description === undefined ? {} : { description: candidate.description }),
      ...(candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow }),
      inputModalities,
      reasoningEfforts: efforts,
      ...(candidate.defaultReasoningEffort === undefined
        ? {}
        : { defaultReasoningEffort: candidate.defaultReasoningEffort }),
    }
  })
  return {
    provider,
    displayName,
    modelProvider,
    models,
    timeoutMs,
    disposeGraceMs,
    maxJsonRpcLineBytes,
    maxRequestImageBytes,
    maxStderrBytes,
    maxRetries,
    maxCachedSessions,
    sessionIdleTimeoutMs,
    capabilities,
    env,
  }
}

function mergeSearchResults(
  queries: readonly string[],
  results: readonly WebSearchResult[],
  maxResults: number,
): WebSearchResult {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  const ranks = Math.max(0, ...results.map(result => result.sources.length))
  let dropped = false
  merge: for (let rank = 0; rank < ranks; rank++) {
    for (const result of results) {
      const source = result.sources[rank]
      if (source === undefined || seen.has(source.url)) continue
      seen.add(source.url)
      if (sources.length === maxResults) {
        dropped = true
        break merge
      }
      sources.push(source)
    }
  }
  const content = results.flatMap((result, index) => result.content === undefined
    ? []
    : [`### ${queries[index]}\n\n${result.content}`])
  return {
    ...(content.length === 0 ? {} : { content: content.join('\n\n') }),
    sources,
    truncated: dropped || results.some(result => result.truncated),
  }
}

async function runCodexSearches(
  search: CodexWebSearchProvider,
  target: { readonly provider: string; readonly model: string },
  queries: readonly string[],
  maxResults: number,
  signal: AbortSignal,
): Promise<WebSearchResult> {
  const controller = new AbortController()
  const combined = AbortSignal.any([signal, controller.signal])
  let firstFailure: { readonly error: unknown } | undefined
  const results: WebSearchResult[] = []
  await Promise.allSettled(queries.map(async (query, index) => {
    try {
      results[index] = await search.search(target, { query, maxResults }, combined)
    } catch (error: unknown) {
      if (firstFailure === undefined) firstFailure = { error }
      controller.abort(error)
      throw error
    }
  }))
  if (firstFailure !== undefined) throw firstFailure.error
  return mergeSearchResults(queries, results, maxResults)
}

/** Register the configured Codex App Server route on `ctx.llm`. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  let capabilitySource: () => CodexCapabilitySettings = () => resolved.capabilities
  const capabilities = (): ResolvedCodexCapabilitySettings => resolveCodexCapabilitySettings(capabilitySource())
  const runner = new CodexAppServerRunner({
    timeoutMs: resolved.timeoutMs,
    disposeGraceMs: resolved.disposeGraceMs,
    maxJsonRpcLineBytes: resolved.maxJsonRpcLineBytes,
    maxStderrBytes: resolved.maxStderrBytes,
    env: resolved.env,
    spawn: spec => ctx.subprocess.spawn(spec),
  })
  const reportCleanupError = (error: unknown): void => {
    ctx.logger.warn(`llm-codex-app-server: cached session cleanup failed: ${String(error)}`)
  }
  const adapter = new CodexAppServerAdapter({
    provider: resolved.provider,
    displayName: resolved.displayName,
    modelProvider: resolved.modelProvider,
    models: resolved.models,
    maxRetries: resolved.maxRetries,
    maxRequestImageBytes: resolved.maxRequestImageBytes,
    maxCachedSessions: resolved.maxCachedSessions,
    sessionIdleTimeoutMs: resolved.sessionIdleTimeoutMs,
    onCleanupError: reportCleanupError,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageGenerationEnabled: () => capabilities().imageGenerationEnabled,
    runner,
  })
  ctx.llm.registerAdapter([resolved.provider], adapter)
  const search = new CodexWebSearchProvider({
    modelProvider: resolved.modelProvider,
    runner,
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'web_search' || exec.agent === undefined) return next()
    const capability = capabilities()
    if (!capability.webSearchEnabled) return next()
    const routed = exec.agent.session.requestHeader()?.config
    const provider = routed?.provider ?? exec.agent.options.provider
    const model = routed?.model ?? exec.agent.options.model
    if (provider !== resolved.provider || model === undefined) return next()
    const args = exec.arguments as { readonly queries?: unknown }
    if (!Array.isArray(args.queries) || !args.queries.every(query => typeof query === 'string')) {
      return next()
    }
    const value = await runCodexSearches(
      search,
      { provider, model: capability.webSearchModel ?? model },
      args.queries,
      capability.webSearchMaxResults,
      exec.signal,
    )
    return { isError: false, value: value as never, content: [] }
  })
  ctx.on('session/disposed', (session) => {
    void adapter.disposeSession(String(session.id)).catch(reportCleanupError)
  })
  installSettingsSection(
    ctx,
    CODEX_SETTINGS_NAMESPACE,
    CodexCapabilitySettingsSchema,
    resolved.capabilities,
    {
      setSource: (source) => { capabilitySource = source },
      // Operations resolve a fresh snapshot and cached threads include it in
      // their epoch, so no registration-level fact needs rebuilding here.
      onChange: () => {},
      validate: (value) => { resolveCodexCapabilitySettings(value) },
    },
  )
  ctx.effect(() => () => adapter.dispose(), 'llm-codex-app-server: dispose cached sessions')
}
