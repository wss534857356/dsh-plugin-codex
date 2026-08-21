import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, MessageId, OFFLOADED_IMAGE_TEXT, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CodexAppServerAdapter } from '../src/adapter.ts'
import type { CodexImageStorePort } from '../src/images.ts'
import type {
  CodexAppServerEvent,
  CodexAppServerRequest,
  CodexAppServerRunnerPort,
  CodexAppServerThreadPort,
  CodexAppServerThreadRequest,
  CodexAppServerTurnRequest,
} from '../src/runner.ts'

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'codex-local',
    model: 'gpt-5.6-sol',
    system: 'Harness system',
    messages: [{
      id: MessageId('user-1'),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    }],
    ...overrides,
  }
}

const INPUT_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const INPUT_PNG = Buffer.from(INPUT_PNG_BASE64, 'base64')
const INPUT_IMAGE_REF = {
  attachmentId: AttachmentId('sha256:input-image'),
  mediaType: 'image/png' as const,
  bytes: INPUT_PNG.byteLength,
  width: 1,
  height: 1,
  name: 'input.png',
}

function inputImageStore(): CodexImageStorePort {
  return {
    imageLimits: {
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 8,
      maxMessageImageBytes: 20 * 1024 * 1024,
      maxImagePixels: 20_000_000,
      maxImageDimension: 2_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    validateImage: vi.fn(async () => {}),
    saveImage: vi.fn(async () => INPUT_IMAGE_REF),
    readImage: vi.fn(async ref => ({ ref, data: INPUT_PNG })),
  }
}

function turnCompleted(status: 'completed' | 'failed' = 'completed'): CodexAppServerEvent {
  return {
    kind: 'notification',
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status,
        error: status === 'completed' ? null : { message: 'status 429: too many requests' },
      },
    },
  }
}

function answerEvents(
  id: string,
  text: string,
  leading: readonly CodexAppServerEvent[] = [],
): CodexAppServerEvent[] {
  return [
    ...leading,
    {
      kind: 'notification',
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: `turn-${id}`,
        item: {
          type: 'message',
          id: `raw-answer-${id}`,
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      },
    },
    {
      kind: 'notification',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: `turn-${id}`,
        item: { type: 'agentMessage', id: `answer-${id}`, text },
      },
    },
    turnCompleted(),
  ]
}

function instance(
  runner: CodexAppServerRunnerPort,
  resolveAttachments: () => CodexImageStorePort | undefined = () => undefined,
  maxRequestImageBytes = 20 * 1024 * 1024,
  resolveImageGenerationEnabled: () => boolean = () => true,
): CodexAppServerAdapter {
  return new CodexAppServerAdapter({
    provider: 'codex-local',
    displayName: 'Codex local',
    modelProvider: 'openai',
    models: [{
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      contextWindow: 272_000,
      inputModalities: ['text', 'image'],
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low',
    }],
    maxRetries: 0,
    maxRequestImageBytes,
    maxCachedSessions: 8,
    sessionIdleTimeoutMs: 600_000,
    onCleanupError: vi.fn(),
    resolveAttachments,
    resolveImageGenerationEnabled,
    runner,
  })
}

function adapter(
  events: readonly CodexAppServerEvent[],
  resolveAttachments: () => CodexImageStorePort | undefined = () => undefined,
  maxRequestImageBytes = 20 * 1024 * 1024,
  resolveImageGenerationEnabled: () => boolean = () => true,
) {
  const stream = vi.fn((input: CodexAppServerRequest): AsyncIterable<CodexAppServerEvent> => {
    return (async function * () {
      void input
      for (const event of events) yield event
    })()
  })
  const runner: CodexAppServerRunnerPort = {
    open: vi.fn(async () => { throw new Error('stateful runner was not expected') }),
    stream,
  }
  return {
    stream,
    adapter: instance(runner, resolveAttachments, maxRequestImageBytes, resolveImageGenerationEnabled),
  }
}

function cachedAdapter(
  turns: readonly (readonly CodexAppServerEvent[])[],
  resolveAttachments: () => CodexImageStorePort | undefined = () => undefined,
  resolveImageGenerationEnabled: () => boolean = () => true,
) {
  const requests: CodexAppServerTurnRequest[] = []
  const thread: CodexAppServerThreadPort = {
    threadId: 'thread-1',
    stream(input: CodexAppServerTurnRequest): AsyncIterable<CodexAppServerEvent> {
      const events = turns[requests.length]
      requests.push(input)
      return (async function * () {
        for (const event of events ?? []) yield event
      })()
    },
    dispose: vi.fn(async () => {}),
  }
  const open = vi.fn(async (_input: CodexAppServerThreadRequest) => thread)
  const oneShot = vi.fn((_input: CodexAppServerRequest) => (async function * () {})())
  return {
    adapter: instance(
      { open, stream: oneShot },
      resolveAttachments,
      20 * 1024 * 1024,
      resolveImageGenerationEnabled,
    ),
    open,
    oneShot,
    requests,
    thread,
  }
}

function replayState(chunks: readonly StreamChunk[]): unknown {
  const finish = chunks.findLast(chunk => chunk.type === 'finish')
  if (finish?.type !== 'finish') throw new Error('test stream emitted no finish')
  return finish.replayState
}

async function collect(instance: CodexAppServerAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of instance.stream(options)) chunks.push(chunk)
  return chunks
}

describe('CodexAppServerAdapter', () => {
  it('advertises the provider, model, context, reasoning, and no retries', async () => {
    const { adapter: instance } = adapter([])
    expect(instance.providerInfo('codex-local')).toEqual({ id: 'codex-local', name: 'Codex local' })
    expect(instance.providerRetryPolicy('codex-local')).toMatchObject({
      mode: 'normal',
      maxRetries: 0,
    })
    expect(await instance.listModels('codex-local')).toEqual([{
      provider: 'codex-local',
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      inputModalities: ['text', 'image'],
    }])
    expect(await instance.resolveModel('codex-local', 'gpt-5.6-sol')).toMatchObject({
      inputModalities: ['text', 'image'],
      context: { contextWindow: 272_000 },
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        defaultEffort: 'low',
      },
    })
    expect(await instance.resolveModel('codex-local', 'uncatalogued')).toMatchObject({
      inputModalities: ['text'],
    })
  })

  it('streams provider disclosure, reasoning, text, usage, and replay state', async () => {
    const events: CodexAppServerEvent[] = [
      {
        kind: 'thread-started',
        threadId: 'thread-1',
        userAgent: 'codex_app_server/0.147.0',
        instructionSources: [{ path: 'C:/Users/test/.codex/AGENTS.md' }],
      },
      {
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'message',
            id: 'codex-context-1',
            role: 'developer',
            content: [{ type: 'input_text', text: 'Codex-owned context' }],
          },
        },
      },
      {
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'message',
            id: 'replayed-user-1',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'provider-generated' },
          },
        },
      },
      {
        kind: 'notification',
        method: 'item/reasoning/summaryTextDelta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0, delta: 'think' },
      },
      {
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'reasoning', encrypted_content: 'opaque', summary: [] },
        },
      },
      {
        kind: 'notification',
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'reasoning', id: 'reasoning-1', summary: ['think'], content: [] },
        },
      },
      {
        kind: 'notification',
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'hello' },
      },
      {
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
        },
      },
      {
        kind: 'notification',
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'message-1', text: 'hello' },
        },
      },
      {
        kind: 'notification',
        method: 'rawResponse/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          usage: {
            totalTokens: 16,
            inputTokens: 10,
            cachedInputTokens: 4,
            cacheWriteInputTokens: 1,
            outputTokens: 6,
            reasoningOutputTokens: 2,
          },
        },
      },
      turnCompleted(),
    ]
    const { adapter: instance, stream } = adapter(events)
    const chunks = await collect(instance, request({ reasoningEffort: ReasoningEffortId('high') }))

    expect(stream).toHaveBeenCalledOnce()
    expect(stream.mock.calls[0]![0]).toMatchObject({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      reasoningEffort: 'high',
      system: 'Harness system',
      history: [expect.objectContaining({ type: 'message', role: 'user' })],
    })
    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'block-end', block: expect.objectContaining({
        type: 'codex-action',
        actionType: 'thread/start',
        category: 'lifecycle',
        protocolEvent: 'thread/start',
        snapshot: expect.objectContaining({ ownership: 'layered' }),
      }) }),
      expect.objectContaining({ type: 'block-end', block: expect.objectContaining({
        type: 'codex-action',
        actionType: 'context/injected',
        category: 'context',
        protocolEvent: 'rawResponseItem/completed',
        snapshot: expect.objectContaining({ role: 'developer' }),
      }) }),
      expect.objectContaining({ type: 'reasoning-delta', text: 'think' }),
      expect.objectContaining({ type: 'text-delta', text: 'hello' }),
      {
        type: 'usage',
        usage: {
          inputTokens: 5,
          outputTokens: 6,
          cacheReadTokens: 4,
          cacheWriteTokens: 1,
          reasoningTokens: 2,
        },
      },
    ]))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: {
        response: {
          kind: 'codex-app-server',
          version: 4,
          items: [
            expect.objectContaining({ type: 'reasoning' }),
            expect.objectContaining({ type: 'message' }),
          ],
          contextItems: [expect.objectContaining({
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'Codex-owned context' }],
          })],
        },
      },
    })
  })

  it('hydrates durable user images only in the one-shot App Server request', async () => {
    const store = inputImageStore()
    const fixture = adapter(answerEvents('image-input', 'described'), () => store)
    const base = request()
    const user = base.messages[0]!
    const chunks = await collect(fixture.adapter, request({
      messages: [{
        ...user,
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', attachment: INPUT_IMAGE_REF },
          { type: 'text', text: 'after' },
        ],
      }],
    }))

    expect(fixture.stream).toHaveBeenCalledOnce()
    expect(fixture.stream.mock.calls[0]?.[0].history).toEqual([{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'before' },
        { type: 'input_image', image_url: `data:image/png;base64,${INPUT_PNG_BASE64}` },
        { type: 'input_text', text: 'after' },
      ],
    }])
    expect(store.readImage).toHaveBeenCalledOnce()
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'image')).toBe(false)
  })

  it('offloads oldest images before reading or encoding the one-shot request', async () => {
    const store = inputImageStore()
    const fixture = adapter(answerEvents('bounded', 'bounded answer'), () => store, 100)
    const first = { ...INPUT_IMAGE_REF, attachmentId: AttachmentId('sha256:first'), name: 'first.png' }
    const second = { ...INPUT_IMAGE_REF, attachmentId: AttachmentId('sha256:second'), name: 'second.png' }
    const base = request()
    await collect(fixture.adapter, request({
      messages: [{
        ...base.messages[0]!,
        content: [
          { type: 'image', attachment: first },
          { type: 'image', attachment: second },
        ],
      }],
    }))

    expect(fixture.stream.mock.calls[0]?.[0].history).toEqual([{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: OFFLOADED_IMAGE_TEXT },
        { type: 'input_image', image_url: `data:image/png;base64,${INPUT_PNG_BASE64}` },
      ],
    }])
    expect(store.readImage).toHaveBeenCalledOnce()
    expect(store.readImage).toHaveBeenCalledWith(second, undefined)
  })

  it('rejects image input for an uncatalogued text-only route before opening App Server', async () => {
    const store = inputImageStore()
    const fixture = adapter([], () => store)
    const base = request()
    await expect(collect(fixture.adapter, request({
      model: 'uncatalogued',
      messages: [{
        ...base.messages[0]!,
        content: [{ type: 'image', attachment: INPUT_IMAGE_REF }],
      }],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(fixture.stream).not.toHaveBeenCalled()
    expect(store.readImage).not.toHaveBeenCalled()
  })

  it('publishes native generated images without retaining their base64 in blocks or replay state', async () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const data = Buffer.from(base64, 'base64')
    const ref = {
      attachmentId: AttachmentId('sha256:image-1'),
      mediaType: 'image/png' as const,
      bytes: data.byteLength,
      width: 1,
      height: 1,
      name: 'generated.png',
    }
    const store: CodexImageStorePort = {
      imageLimits: {
        maxImageBytes: 5 * 1024 * 1024,
        maxImagesPerMessage: 8,
        maxMessageImageBytes: 20 * 1024 * 1024,
        maxImagePixels: 20_000_000,
        maxImageDimension: 2_000,
        mediaTypes: ['image/png'],
      },
      validateImage: vi.fn(async () => {}),
      saveImage: vi.fn(async () => ref),
      readImage: vi.fn(async value => ({ ref: value, data })),
    }
    const leading: CodexAppServerEvent[] = [
      {
        kind: 'notification',
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-image',
          item: {
            type: 'imageGeneration',
            id: 'image-1',
            status: 'completed',
            result: base64,
            savedPath: 'C:\\Users\\test\\.codex\\generated_images\\generated.png',
          },
        },
      },
      {
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-image',
          item: {
            type: 'function_call_output',
            id: 'output-1',
            call_id: 'call-1',
            output: [
              { type: 'input_text', text: 'generated' },
              { type: 'input_image', image_url: `data:image/png;base64,${base64}`, detail: 'high' },
            ],
          },
        },
      },
    ]
    const { adapter: instance } = adapter(answerEvents('image', 'created', leading), () => store)
    const chunks = await collect(instance, request())

    expect(chunks).toContainEqual({
      type: 'block-end',
      index: expect.any(Number),
      block: { type: 'image', attachment: ref },
    })
    const finish = chunks.findLast(chunk => chunk.type === 'finish')
    expect(finish).toMatchObject({
      replayState: {
        response: {
          version: 4,
          items: [
            expect.objectContaining({
              type: 'function_call_output',
              output: expect.arrayContaining([expect.objectContaining({
                type: 'input_image',
                image_url: expect.objectContaining({ kind: 'dsh-image-attachment' }),
              })]),
            }),
            expect.objectContaining({ type: 'message', role: 'assistant' }),
          ],
        },
      },
    })
    expect(JSON.stringify(chunks)).not.toContain(base64)
    expect(store.saveImage).toHaveBeenCalledOnce()
  })

  it('reuses one session thread and appends the next user message through turn input', async () => {
    const cached = cachedAdapter([
      answerEvents('1', 'first answer'),
      answerEvents('2', 'second answer'),
    ])
    const firstRequest = request({ sessionId: SessionId('session-1') })
    const firstChunks = await collect(cached.adapter, firstRequest)
    const firstAnswer: Message = {
      id: MessageId('assistant-1'),
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'codex-local',
        model: 'gpt-5.6-sol',
        replayState: replayState(firstChunks),
      },
      content: [{ type: 'text', text: 'first answer' }],
    }
    const followUp: Message = {
      id: MessageId('user-2'),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'follow up' }],
    }

    const secondChunks = await collect(cached.adapter, request({
      sessionId: SessionId('session-1'),
      messages: [...firstRequest.messages, firstAnswer, followUp],
    }))

    expect(cached.open).toHaveBeenCalledOnce()
    expect(cached.oneShot).not.toHaveBeenCalled()
    expect(cached.requests).toHaveLength(2)
    expect(cached.requests[0]).toMatchObject({
      injectedItems: [expect.objectContaining({ role: 'user' })],
      input: [],
    })
    expect(cached.requests[1]).toMatchObject({
      input: [{ type: 'text', text: 'follow up', text_elements: [] }],
    })
    expect(secondChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    await cached.adapter.dispose()
  })

  it('rebuilds a cached session when the image-generation setting changes', async () => {
    let imageGenerationEnabled = true
    const cached = cachedAdapter([
      answerEvents('1', 'first answer'),
      answerEvents('2', 'second answer'),
    ], () => undefined, () => imageGenerationEnabled)
    const firstRequest = request({ sessionId: SessionId('session-setting') })
    const firstChunks = await collect(cached.adapter, firstRequest)
    const firstAnswer: Message = {
      id: MessageId('assistant-setting-1'),
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'codex-local',
        model: 'gpt-5.6-sol',
        replayState: replayState(firstChunks),
      },
      content: [{ type: 'text', text: 'first answer' }],
    }
    imageGenerationEnabled = false

    await collect(cached.adapter, request({
      sessionId: SessionId('session-setting'),
      messages: [
        ...firstRequest.messages,
        firstAnswer,
        {
          id: MessageId('user-setting-2'),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'follow up' }],
        },
      ],
    }))

    expect(cached.open).toHaveBeenCalledTimes(2)
    expect(cached.open.mock.calls[0]?.[0]).toMatchObject({ imageGenerationEnabled: true })
    expect(cached.open.mock.calls[1]?.[0]).toMatchObject({ imageGenerationEnabled: false })
    expect(cached.requests[1]).toMatchObject({
      injectedItems: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
      input: [],
    })
    await cached.adapter.dispose()
  })

  it('hydrates only the appended image message on a warm session thread', async () => {
    const store = inputImageStore()
    const cached = cachedAdapter([
      answerEvents('1', 'first answer'),
      answerEvents('2', 'image answer'),
    ], () => store)
    const firstRequest = request({ sessionId: SessionId('session-image') })
    const firstChunks = await collect(cached.adapter, firstRequest)
    const firstAnswer: Message = {
      id: MessageId('assistant-image-1'),
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'codex-local',
        model: 'gpt-5.6-sol',
        replayState: replayState(firstChunks),
      },
      content: [{ type: 'text', text: 'first answer' }],
    }
    const followUp: Message = {
      id: MessageId('user-image-2'),
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'inspect' },
        { type: 'image', attachment: INPUT_IMAGE_REF },
      ],
    }

    await collect(cached.adapter, request({
      sessionId: SessionId('session-image'),
      messages: [...firstRequest.messages, firstAnswer, followUp],
    }))

    expect(cached.open).toHaveBeenCalledOnce()
    expect(cached.requests[1]).toMatchObject({
      input: [
        { type: 'text', text: 'inspect', text_elements: [] },
        { type: 'image', url: `data:image/png;base64,${INPUT_PNG_BASE64}` },
      ],
    })
    expect(cached.requests[1]?.injectedItems).toBeUndefined()
    expect(store.readImage).toHaveBeenCalledOnce()
    await cached.adapter.dispose()
  })

  it('discards a thread after native Codex compaction and cold-rebuilds the next request', async () => {
    const cached = cachedAdapter([
      answerEvents('1', 'first answer', [{
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'context_compaction', encrypted_content: 'opaque' },
        },
      }]),
      answerEvents('2', 'second answer'),
    ])
    const firstRequest = request({ sessionId: SessionId('session-1') })
    const firstChunks = await collect(cached.adapter, firstRequest)
    const firstAnswer: Message = {
      id: MessageId('assistant-1'),
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'codex-local',
        model: 'gpt-5.6-sol',
        replayState: replayState(firstChunks),
      },
      content: [{ type: 'text', text: 'first answer' }],
    }

    await collect(cached.adapter, request({
      sessionId: SessionId('session-1'),
      messages: [
        ...firstRequest.messages,
        firstAnswer,
        {
          id: MessageId('user-2'),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'continue' }],
        },
      ],
    }))

    expect(cached.open).toHaveBeenCalledTimes(2)
    expect(cached.thread.dispose).toHaveBeenCalledOnce()
    expect(cached.requests[1]).toMatchObject({
      injectedItems: expect.arrayContaining([expect.objectContaining({ role: 'assistant' })]),
      input: [],
    })
    await cached.adapter.dispose()
  })

  it('continues a pending tool callback and reports cache usage at the tool boundary', async () => {
    const toolEvents: CodexAppServerEvent[] = [
      {
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'function_call',
            id: 'provider-item-1',
            call_id: 'call-1',
            namespace: 'deepseek_harness',
            name: 'read_file',
            arguments: '{"path":"a.txt"}',
          },
        },
      },
      {
        kind: 'notification',
        method: 'rawResponse/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          usage: {
            inputTokens: 100,
            cachedInputTokens: 80,
            outputTokens: 5,
          },
        },
      },
      {
        kind: 'server-request',
        id: 'rpc-1',
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-1',
          namespace: 'deepseek_harness',
          tool: 'read_file',
          arguments: { path: 'a.txt' },
        },
        resolution: 'rejected',
      },
    ]
    const store = inputImageStore()
    const cached = cachedAdapter([toolEvents, answerEvents('1', 'contents received')], () => store)
    const tools = [{
      name: 'read_file',
      description: 'Read one file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }]
    const firstRequest = request({ sessionId: SessionId('session-1'), tools })
    const firstChunks = await collect(cached.adapter, firstRequest)
    expect(firstChunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 80 },
    })
    const callId = CallId('call-1')
    const firstAnswer: Message = {
      id: MessageId('assistant-1'),
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'codex-local',
        model: 'gpt-5.6-sol',
        replayState: replayState(firstChunks),
      },
      content: [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"a.txt"}' }],
    }
    const result: Message = {
      id: MessageId('tool-1'),
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [
          { type: 'text', text: 'contents' },
          { type: 'image', attachment: INPUT_IMAGE_REF },
        ],
        isError: false,
      }],
    }

    const secondChunks = await collect(cached.adapter, request({
      sessionId: SessionId('session-1'),
      tools,
      messages: [...firstRequest.messages, firstAnswer, result],
    }))

    expect(cached.open).toHaveBeenCalledOnce()
    expect(cached.requests[1]).toMatchObject({
      toolResult: {
        callId: 'call-1',
        contentItems: [
          { type: 'inputText', text: 'contents' },
          { type: 'inputImage', imageUrl: `data:image/png;base64,${INPUT_PNG_BASE64}` },
        ],
        success: true,
      },
    })
    expect(store.readImage).toHaveBeenCalledOnce()
    expect(secondChunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'image')).toBe(false)
    expect(secondChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    await cached.adapter.dispose()
  })

  it('hands dynamic tools to Harness and ends the step without provider execution', async () => {
    const events: CodexAppServerEvent[] = [
      {
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'function_call',
            id: 'provider-item-1',
            call_id: 'call-1',
            namespace: 'deepseek_harness',
            name: 'read_file',
            arguments: '{"path":"a.txt"}',
          },
        },
      },
      {
        kind: 'server-request',
        id: 'rpc-1',
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-1',
          namespace: 'deepseek_harness',
          tool: 'read_file',
          arguments: { path: 'a.txt' },
        },
        resolution: 'rejected',
      },
    ]
    const { adapter: instance } = adapter(events)
    const chunks = await collect(instance, request({
      tools: [{
        name: 'read_file',
        description: 'Read one file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
    }))

    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'call-1',
          name: 'read_file',
          arguments: '{"path":"a.txt"}',
        },
      }),
    ]))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: {
        response: {
          items: [expect.objectContaining({
            type: 'function_call',
            call_id: 'call-1',
            namespace: 'deepseek_harness',
          })],
        },
      },
    })
    expect(chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'codex-action'
      ? [chunk.block]
      : [])).toEqual([])
  })

  it('drops a suspended Code Mode call from cold replay while retaining the Harness callback', async () => {
    const events: CodexAppServerEvent[] = [
      {
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'custom_tool_call',
            id: 'code-mode-item-1',
            call_id: 'code-mode-call-1',
            name: 'exec',
            status: 'completed',
            input: 'await tools.read_file({ path: "a.txt" })',
          },
        },
      },
      {
        kind: 'server-request',
        id: 'rpc-code-mode-1',
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-code-mode-1',
          namespace: 'deepseek_harness',
          tool: 'read_file',
          arguments: { path: 'a.txt' },
        },
        resolution: 'rejected',
      },
    ]
    const { adapter: instance } = adapter(events)
    const chunks = await collect(instance, request({
      tools: [{
        name: 'read_file',
        description: 'Read one file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
    }))
    const finish = chunks.at(-1)

    expect(finish).toMatchObject({
      type: 'finish',
      replayState: {
        response: {
          items: [expect.objectContaining({
            type: 'function_call',
            call_id: 'call-code-mode-1',
            namespace: 'deepseek_harness',
          })],
        },
      },
    })
    expect(JSON.stringify(finish)).not.toContain('code-mode-call-1')
    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'block-end',
        block: expect.objectContaining({ type: 'codex-action', actionType: 'custom_tool_call' }),
      }),
    ]))
  })

  it('reports raw Code Mode calls and outcomes as Codex actions', async () => {
    const events: CodexAppServerEvent[] = [
      {
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'custom_tool_call',
            id: 'raw-call-item-1',
            call_id: 'native-call-1',
            name: 'exec',
            status: 'completed',
            input: 'await tools.update_plan({ plan: [] })',
          },
        },
      },
      {
        kind: 'notification',
        method: 'turn/plan/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          explanation: null,
          plan: [{ step: 'Inspect', status: 'completed' }],
        },
      },
      {
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'custom_tool_call_output',
            id: 'raw-output-item-1',
            call_id: 'native-call-1',
            output: [{ type: 'input_text', text: '{}' }],
          },
        },
      },
      turnCompleted(),
    ]
    const { adapter: instance } = adapter(events)
    const chunks = await collect(instance, request())
    const actions = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'codex-action'
      ? [chunk.block]
      : [])

    expect(actions).toEqual([
      expect.objectContaining({
        actionId: 'native-call-1',
        actionType: 'custom_tool_call',
        category: 'action',
        phase: 'requested',
        protocolEvent: 'rawResponseItem/completed',
        snapshot: expect.objectContaining({ name: 'exec' }),
      }),
      expect.objectContaining({
        actionType: 'turn/plan/updated',
        category: 'action',
        phase: 'updated',
        protocolEvent: 'turn/plan/updated',
      }),
      expect.objectContaining({
        actionId: 'native-call-1',
        actionType: 'custom_tool_call_output',
        category: 'action',
        phase: 'completed',
        protocolEvent: 'rawResponseItem/completed',
      }),
    ])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: {
        response: {
          items: [
            expect.objectContaining({ type: 'custom_tool_call', call_id: 'native-call-1' }),
            expect.objectContaining({ type: 'custom_tool_call_output', call_id: 'native-call-1' }),
          ],
        },
      },
    })
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
  })

  it('renders Codex-native action lifecycles without marking the request failed', async () => {
    const events: CodexAppServerEvent[] = [
      {
        kind: 'notification',
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'commandExecution', id: 'command-1', command: 'pwd', status: 'inProgress' },
        },
      },
      {
        kind: 'notification',
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'commandExecution',
            id: 'command-1',
            command: 'pwd',
            status: 'failed',
            aggregatedOutput: 'permission denied',
            exitCode: 1,
          },
        },
      },
      turnCompleted(),
    ]
    const { adapter: instance } = adapter(events)
    const chunks = await collect(instance, request())
    const actions = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'codex-action'
      ? [chunk.block]
      : [])

    expect(actions).toEqual([
      expect.objectContaining({ actionType: 'commandExecution', phase: 'started' }),
      expect.objectContaining({
        actionType: 'commandExecution',
        category: 'action',
        phase: 'failed',
        protocolEvent: 'item/completed',
        snapshot: expect.objectContaining({ aggregatedOutput: 'permission denied', exitCode: 1 }),
      }),
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
  })

  it.each([
    { temperature: 0 },
    { maxTokens: 10 },
    { stop: ['END'] },
  ] satisfies Array<Partial<GenerateOptions>>)('rejects unsupported App Server option %#', async (override) => {
    const { adapter: instance, stream } = adapter([])
    await expect(collect(instance, request(override))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(stream).not.toHaveBeenCalled()
  })

  it('uses Codex for compaction while treating its maxTokens cap as advisory', async () => {
    const setup = adapter(answerEvents('compact', '## Primary Request and Intent\n- Continue the task.'))
    const chunks = await collect(setup.adapter, request({
      purpose: 'compaction',
      maxTokens: 8192,
      tools: [{
        name: 'read',
        description: 'Read a file.',
        parameters: { type: 'object', properties: {} },
      }],
    }))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(setup.stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol',
      dynamicTools: [],
      imageGenerationEnabled: false,
    }))
  })

  it('captures the live image-generation setting for an ordinary turn', async () => {
    let enabled = false
    const setup = adapter(answerEvents('setting', 'done'), () => undefined, 20 * 1024 * 1024, () => enabled)

    await collect(setup.adapter, request())
    expect(setup.stream).toHaveBeenLastCalledWith(expect.objectContaining({
      imageGenerationEnabled: false,
    }))

    enabled = true
    await collect(setup.adapter, request())
    expect(setup.stream).toHaveBeenLastCalledWith(expect.objectContaining({
      imageGenerationEnabled: true,
    }))
  })

  it('maps an actual failed Codex turn', async () => {
    const { adapter: instance } = adapter([turnCompleted('failed')])
    await expect(collect(instance, request())).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })
})
