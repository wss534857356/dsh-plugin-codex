/** DeepSeek Harness main-model provider backed by the locally authenticated Codex App Server. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CodexAppServerAdapter } from './adapter.ts'
import type { CodexModel } from './adapter.ts'
import { SAFE_MODEL_ID, SAFE_REASONING_EFFORT } from './identifiers.ts'
import { CodexAppServerRunner } from './runner.ts'

export { CodexAppServerAdapter } from './adapter.ts'
export type { CodexAdapterOptions, CodexModel } from './adapter.ts'
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
  CodexAppServerRequest,
  CodexAppServerRunnerOptions,
  CodexAppServerRunnerPort,
  CodexAppServerThreadPort,
  CodexAppServerThreadRequest,
  CodexAppServerToolResult,
  CodexAppServerTurnRequest,
  JsonValue,
} from './runner.ts'

export const name = 'llm-codex-app-server'
export const inject = ['llm', 'subprocess']

/** Plugin configuration for one static provider route. */
export interface Config {
  provider?: string
  displayName?: string
  modelProvider?: string
  models?: Array<{
    id: string
    name?: string
    description?: string
    contextWindow?: number
    reasoningEfforts?: string[]
    defaultReasoningEffort?: string
  }>
  timeoutMs?: number
  disposeGraceMs?: number
  maxJsonRpcLineBytes?: number
  maxStderrBytes?: number
  maxRetries?: number
  env?: Record<string, string>
}

const DEFAULT_MODELS = [{
  id: 'gpt-5.6-sol',
  name: 'GPT-5.6 Sol',
  description: 'Codex CLI model reached through the local account session.',
  contextWindow: 272_000,
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  defaultReasoningEffort: 'low',
}]

const modelSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
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
  maxJsonRpcLineBytes: z.number().step(1).min(1).default(4 * 1024 * 1024),
  maxStderrBytes: z.number().step(1).min(1).default(64 * 1024),
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(0),
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
  readonly maxStderrBytes: number
  readonly maxRetries: number
  readonly env: Readonly<Record<string, string>>
}

const SAFE_ROUTE = /^[a-z0-9][a-z0-9._-]{0,79}$/u

function resolveConfig(config: Config): ResolvedConfig {
  const provider = config.provider ?? 'codex-local'
  const displayName = config.displayName ?? 'Codex (local login)'
  const modelProvider = config.modelProvider ?? 'openai'
  const timeoutMs = config.timeoutMs ?? 300_000
  const disposeGraceMs = config.disposeGraceMs ?? 3_000
  const maxJsonRpcLineBytes = config.maxJsonRpcLineBytes ?? 4 * 1024 * 1024
  const maxStderrBytes = config.maxStderrBytes ?? 64 * 1024
  const maxRetries = config.maxRetries ?? 0
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
  if (!Number.isSafeInteger(maxStderrBytes) || maxStderrBytes <= 0) {
    throw new Error('llm-codex-app-server: maxStderrBytes must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error('llm-codex-app-server: maxRetries must be a non-negative safe integer')
  }
  const configuredModels = config.models ?? DEFAULT_MODELS
  if (configuredModels.length === 0) throw new Error('llm-codex-app-server: models must not be empty')
  const seen = new Set<string>()
  const models = configuredModels.map((candidate): CodexModel => {
    if (!SAFE_MODEL_ID.test(candidate.id) || seen.has(candidate.id)) {
      throw new Error(`llm-codex-app-server: invalid or duplicate model id ${JSON.stringify(candidate.id)}`)
    }
    seen.add(candidate.id)
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
    maxStderrBytes,
    maxRetries,
    env,
  }
}

/** Register the configured Codex App Server route on `ctx.llm`. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const runner = new CodexAppServerRunner({
    timeoutMs: resolved.timeoutMs,
    disposeGraceMs: resolved.disposeGraceMs,
    maxJsonRpcLineBytes: resolved.maxJsonRpcLineBytes,
    maxStderrBytes: resolved.maxStderrBytes,
    env: resolved.env,
    spawn: spec => ctx.subprocess.spawn(spec),
  })
  ctx.llm.registerAdapter([resolved.provider], new CodexAppServerAdapter({
    provider: resolved.provider,
    displayName: resolved.displayName,
    modelProvider: resolved.modelProvider,
    models: resolved.models,
    maxRetries: resolved.maxRetries,
    runner,
  }))
}
