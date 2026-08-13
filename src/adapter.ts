/** Harness LLM adapter backed by one ephemeral Codex CLI process per request. */

import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { buildBridgePrompt, codexFailureCode, parseCodexJsonl, responseChunks } from './protocol.ts'
import type { CodexRunnerPort } from './runner.ts'

/** One model exposed in the Harness selector. */
export interface CodexModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly contextWindow?: number
  readonly reasoningEfforts: readonly string[]
  readonly defaultReasoningEffort?: string
}

/** Stable route facts captured by one adapter instance. */
export interface CodexAdapterOptions {
  readonly provider: string
  readonly displayName: string
  readonly models: readonly CodexModel[]
  readonly maxRetries: number
  readonly runner: CodexRunnerPort
}

const RETRYABLE_CODES = Object.freeze(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

function modelInfo(provider: string, model: CodexModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: ['text'],
  }
}

/** Main-model adapter that translates complete Harness calls through `codex exec`. */
export class CodexExecAdapter extends LlmAdapter {
  constructor(private readonly options: CodexAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.displayName }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return {
      mode: 'normal',
      maxRetries: this.options.maxRetries,
      retryableCodes: RETRYABLE_CODES,
      initialDelayMs: 1_000,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.options.models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const configured = this.options.models.find(candidate => candidate.id === model)
    const fallback: CodexModel = {
      id: model,
      name: model,
      reasoningEfforts: [],
    }
    const resolved = configured ?? fallback
    return Promise.resolve({
      ...modelInfo(provider, resolved),
      ...(resolved.contextWindow === undefined
        ? {}
        : { context: { contextWindow: resolved.contextWindow } }),
      ...(resolved.reasoningEfforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: resolved.reasoningEfforts.map(effort => ({
                id: ReasoningEffortId(effort),
                name: effort.charAt(0).toUpperCase() + effort.slice(1),
              })),
              ...(resolved.defaultReasoningEffort === undefined
                ? {}
                : { defaultEffort: ReasoningEffortId(resolved.defaultReasoningEffort) }),
            },
          }),
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.temperature !== undefined || options.maxTokens !== undefined || options.stop !== undefined) {
      throw new LlmError(
        'Codex CLI bridge does not support temperature, maxTokens, or stop overrides',
        'UNSUPPORTED_OPTION',
      )
    }
    const result = await this.options.runner.run({
      model: options.model,
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: String(options.reasoningEffort) }),
      prompt: buildBridgePrompt(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (result.exitCode !== 0 || result.signal !== null) {
      const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
      const suffix = detail.length === 0 ? '' : `: ${detail.slice(-4_000)}`
      throw new LlmError(
        `Codex process exited with code ${String(result.exitCode)} and signal ${String(result.signal)}${suffix}`,
        codexFailureCode(detail),
      )
    }
    for (const chunk of responseChunks(parseCodexJsonl(result.stdout, options.tools))) yield chunk
  }
}
