import { describe, expect, it, vi } from 'vitest'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodexAppServerAdapter } from '../src/adapter.ts'
import type {
  CodexAppServerEvent,
  CodexAppServerRequest,
  CodexAppServerRunnerPort,
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

function adapter(events: readonly CodexAppServerEvent[]) {
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
    adapter: new CodexAppServerAdapter({
      provider: 'codex-local',
      displayName: 'Codex local',
      modelProvider: 'openai',
      models: [{
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        contextWindow: 272_000,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'low',
      }],
      maxRetries: 0,
      runner,
    }),
  }
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
      inputModalities: ['text'],
    }])
    expect(await instance.resolveModel('codex-local', 'gpt-5.6-sol')).toMatchObject({
      context: { contextWindow: 272_000 },
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        defaultEffort: 'low',
      },
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
        kind: 'codex-app-server',
        version: 1,
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
    })
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
          namespace: null,
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
        items: [expect.objectContaining({ type: 'function_call', call_id: 'call-1' })],
      },
    })
    expect(chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'codex-action'
      ? [chunk.block]
      : [])).toEqual([])
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
        items: [
          expect.objectContaining({ type: 'custom_tool_call', call_id: 'native-call-1' }),
          expect.objectContaining({ type: 'custom_tool_call_output', call_id: 'native-call-1' }),
        ],
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

  it('maps an actual failed Codex turn', async () => {
    const { adapter: instance } = adapter([turnCompleted('failed')])
    await expect(collect(instance, request())).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })
})
