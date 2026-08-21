/** Harness LLM adapter backed by one ephemeral Codex App Server per request. */

import {
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { HARNESS_TOOL_NAMESPACE } from './identifiers.ts'
import { boundRequestImageHistory, NativeImageBridge } from './images.ts'
import type { CodexImageStorePort } from './images.ts'
import {
  AppServerEventMapper,
  appServerDynamicTools,
  appServerHistory,
  appServerToolResults,
  assertCompletedTurn,
  extendAppServerHistory,
  harnessToolCall,
} from './protocol.ts'
import { CODEX_APP_SERVER_VERSION } from './runner.ts'
import type {
  CodexAppServerEvent,
  CodexAppServerRunnerPort,
  JsonValue,
} from './runner.ts'
import { CodexSessionCache } from './session-cache.ts'
import type { CodexSessionStep } from './session-cache.ts'

/** One model exposed in the Harness selector. */
export interface CodexModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly contextWindow?: number
  readonly inputModalities: readonly ModelModality[]
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
  readonly maxRequestImageBytes: number
  readonly maxCachedSessions: number
  readonly sessionIdleTimeoutMs: number
  readonly onCleanupError: (error: unknown) => void
  readonly resolveAttachments: () => CodexImageStorePort | undefined
  /** Resolve the live settings snapshot captured by the next model operation. */
  readonly resolveImageGenerationEnabled?: () => boolean
  readonly runner: CodexAppServerRunnerPort
}

const RETRYABLE_CODES = Object.freeze(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

function modelInfo(provider: string, model: CodexModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: [...model.inputModalities],
  }
}

/** Main-model adapter that maps live App Server events into the Harness loop. */
export class CodexAppServerAdapter extends LlmAdapter {
  private readonly cache: CodexSessionCache

  constructor(private readonly options: CodexAdapterOptions) {
    super()
    this.cache = new CodexSessionCache({
      runner: options.runner,
      maxSessions: options.maxCachedSessions,
      idleTimeoutMs: options.sessionIdleTimeoutMs,
      onCleanupError: options.onCleanupError,
    })
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
      inputModalities: ['text'],
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
    const compaction = options.purpose === 'compaction'
    // Compaction is a closed text generation. Even when ordinary turns expose
    // image generation, a summarizer must not be able to start unrelated work.
    const imageGenerationEnabled = !compaction
      && (this.options.resolveImageGenerationEnabled?.() ?? true)
    if (options.temperature !== undefined
      || (options.maxTokens !== undefined && !compaction)
      || options.stop !== undefined) {
      throw new LlmError(
        'Codex App Server provider does not support temperature, maxTokens, or stop overrides',
        'UNSUPPORTED_OPTION',
      )
    }
    const hasImages = options.messages.some(message => contentHasImage(message.content))
    const configuredModel = this.options.models.find(model => model.id === options.model)
    if (hasImages && configuredModel?.inputModalities.includes('image') !== true) {
      throw new LlmError(
        `Codex model "${options.model}" does not accept image input`,
        'UNSUPPORTED_CONTENT',
      )
    }
    const history = boundRequestImageHistory(
      appServerHistory(options),
      this.options.maxRequestImageBytes,
    )
    const images = new NativeImageBridge(this.options.resolveAttachments)
    images.rememberHistory(history)
    // The compaction instruction is a closed auxiliary generation. Replaying
    // the historical tool items preserves meaning, but re-declaring live tools
    // would let the summarizer start new work instead of producing a checkpoint.
    const dynamicTools = compaction ? [] : appServerDynamicTools(options.tools, options.messages)
    const mapper = new AppServerEventMapper(history, options.tools?.map(tool => tool.name))
    const reasoningEffort = options.reasoningEffort === undefined
      ? undefined
      : String(options.reasoningEffort)
    let cached: CodexSessionStep | undefined
    let events: AsyncIterable<CodexAppServerEvent>
    if (options.sessionId === undefined || options.purpose !== undefined) {
      const injectedHistory = await images.hydrateHistory(history, options.signal)
      events = this.options.runner.stream({
        model: options.model,
        modelProvider: this.options.modelProvider,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        system: options.system ?? '',
        history: injectedHistory,
        dynamicTools,
        imageGenerationEnabled,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } else {
      cached = await this.cache.begin({
        sessionId: String(options.sessionId),
        epoch: this.cacheEpoch(options, dynamicTools, imageGenerationEnabled),
        thread: {
          model: options.model,
          modelProvider: this.options.modelProvider,
          system: options.system ?? '',
          dynamicTools,
          imageGenerationEnabled,
        },
        history,
        loadInjectedHistory: () => images.hydrateHistory(history, options.signal),
        loadUserInput: content => images.hydrateUserInput(content, options.signal),
        loadToolResult: result => images.hydrateToolResult(result, options.signal),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        toolResults: appServerToolResults(options, history),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      events = cached.events
    }
    let retained = false
    try {
      for await (const event of events) {
        const projected = await images.externalize(event)
        for (const chunk of mapper.accept(projected.event)) yield chunk
        for (const image of projected.images) {
          for (const chunk of mapper.image(image)) yield chunk
        }
        if (projected.event.kind === 'server-request'
          && projected.event.method === 'item/tool/call'
          && projected.event.params.namespace === HARNESS_TOOL_NAMESPACE) {
          for (const chunk of mapper.closeOpen()) yield chunk
          const call = harnessToolCall(projected.event, options.tools, options.messages)
          for (const chunk of mapper.toolCall(call)) yield chunk
          const usage = mapper.usage()
          if (usage !== undefined) yield { type: 'usage', usage }
          const replayState = mapper.replayState()
          retained = await this.settleCache(cached, mapper, history, replayState.items, String(call.id))
          yield {
            type: 'finish',
            reason: { kind: 'tool-calls' },
            replayState: { response: replayState },
          }
          return
        }
        if (projected.event.kind === 'notification' && projected.event.method === 'turn/completed') {
          for (const chunk of mapper.closeOpen()) yield chunk
          assertCompletedTurn(projected.event)
          const usage = mapper.usage()
          if (usage !== undefined) yield { type: 'usage', usage }
          const replayState = mapper.replayState()
          retained = await this.settleCache(cached, mapper, history, replayState.items)
          yield {
            type: 'finish',
            reason: { kind: 'stop' },
            replayState: { response: replayState },
          }
          return
        }
      }
      throw new LlmError('Codex App Server stream ended without a terminal event', 'TRANSPORT')
    } finally {
      if (!retained) await cached?.discard()
    }
  }

  /** Dispose the cached process for one ended Harness session. */
  disposeSession(sessionId: string): Promise<void> {
    return this.cache.disposeSession(sessionId)
  }

  /** Dispose every cached process owned by this adapter. */
  dispose(): Promise<void> {
    return this.cache.dispose()
  }

  private cacheEpoch(
    options: GenerateOptions,
    dynamicTools: readonly JsonValue[],
    imageGenerationEnabled: boolean,
  ): JsonValue {
    return {
      version: 1,
      appServerVersion: CODEX_APP_SERVER_VERSION,
      provider: options.provider,
      modelProvider: this.options.modelProvider,
      model: options.model,
      reasoningEffort: options.reasoningEffort === undefined ? null : String(options.reasoningEffort),
      system: options.system ?? '',
      dynamicTools: [...dynamicTools],
      imageGenerationEnabled,
      maxRequestImageBytes: this.options.maxRequestImageBytes,
      threadPolicy: 'harness-read-only-no-native-compaction-image-input-v1',
    }
  }

  private async settleCache(
    cached: CodexSessionStep | undefined,
    mapper: AppServerEventMapper,
    history: readonly JsonValue[],
    outputs: readonly JsonValue[],
    pendingCallId?: string,
  ): Promise<boolean> {
    if (cached === undefined) return false
    if (!mapper.canReuseThread()) {
      await cached.discard()
      return false
    }
    cached.commit(extendAppServerHistory(history, outputs), pendingCallId)
    return true
  }
}
