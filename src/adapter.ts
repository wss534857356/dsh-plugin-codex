/** Harness LLM adapter backed by one ephemeral Codex App Server per request. */

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
import {
  AppServerEventMapper,
  appServerDynamicTools,
  appServerHistory,
  assertCompletedTurn,
  harnessToolCall,
} from './protocol.ts'
import type { CodexAppServerRunnerPort } from './runner.ts'

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
  readonly modelProvider: string
  readonly models: readonly CodexModel[]
  readonly maxRetries: number
  readonly runner: CodexAppServerRunnerPort
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

/** Main-model adapter that maps live App Server events into the Harness loop. */
export class CodexAppServerAdapter extends LlmAdapter {
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
        'Codex App Server provider does not support temperature, maxTokens, or stop overrides',
        'UNSUPPORTED_OPTION',
      )
    }
    const history = appServerHistory(options)
    const mapper = new AppServerEventMapper(history, options.tools?.map(tool => tool.name))
    for await (const event of this.options.runner.stream({
      model: options.model,
      modelProvider: this.options.modelProvider,
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: String(options.reasoningEffort) }),
      system: options.system ?? '',
      history,
      dynamicTools: appServerDynamicTools(options.tools),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })) {
      for (const chunk of mapper.accept(event)) yield chunk
      if (event.kind === 'server-request' && event.method === 'item/tool/call') {
        for (const chunk of mapper.closeOpen()) yield chunk
        const call = harnessToolCall(event, options.tools)
        for (const chunk of mapper.toolCall(call)) yield chunk
        yield {
          type: 'finish',
          reason: { kind: 'tool-calls' },
          replayState: mapper.replayState(),
        }
        return
      }
      if (event.kind === 'notification' && event.method === 'turn/completed') {
        for (const chunk of mapper.closeOpen()) yield chunk
        assertCompletedTurn(event)
        const usage = mapper.usage()
        if (usage !== undefined) yield { type: 'usage', usage }
        yield {
          type: 'finish',
          reason: { kind: 'stop' },
          replayState: mapper.replayState(),
        }
        return
      }
    }
    throw new LlmError('Codex App Server stream ended without a terminal event', 'TRANSPORT')
  }
}
