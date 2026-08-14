import { describe, expect, it } from 'vitest'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  AppServerEventMapper,
  appServerDynamicTools,
  appServerHistory,
  appServerToolResults,
  assertCompletedTurn,
  codexFailureCode,
  extendAppServerHistory,
  harnessToolCall,
} from '../src/protocol.ts'
import type { CodexAppServerEvent } from '../src/runner.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'codex-local',
    model: 'gpt-5.6-sol',
    messages: [{
      id: MessageId('user-1'),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    }],
    ...overrides,
  }
}

describe('App Server protocol translation', () => {
  it('preserves ordered Harness messages, tool calls, and tool results', () => {
    const callId = CallId('call-1')
    const history = appServerHistory(options({
      messages: [
        {
          id: MessageId('user-1'),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'read it' }],
        },
        {
          id: MessageId('assistant-1'),
          role: 'assistant',
          source: { kind: 'model', provider: 'other-provider', model: 'other-model' },
          content: [
            {
              type: 'codex-action',
              actionId: 'native-1',
              actionType: 'commandExecution',
              category: 'action',
              phase: 'completed',
              protocolEvent: 'item/completed',
              snapshot: { command: 'pwd' },
            },
            { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"a.txt"}' },
          ],
        },
        {
          id: MessageId('tool-1'),
          role: 'user',
          source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: 'contents' }],
          }],
        },
      ],
    }))

    expect(history).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'read it' }],
      },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'contents',
      },
    ])
  })

  it('uses same-provider raw replay items instead of reconstructing assistant output', () => {
    const raw = {
      type: 'reasoning',
      encrypted_content: 'opaque',
      summary: [{ type: 'summary_text', text: 'summary' }],
    }
    const history = appServerHistory(options({
      messages: [{
        id: MessageId('assistant-1'),
        role: 'assistant',
        source: {
          kind: 'model',
          provider: 'codex-local',
          model: 'gpt-5.6-sol',
          replayState: { kind: 'codex-app-server', version: 1, items: [raw], contextItems: [] },
        },
        content: [{ type: 'text', text: 'reconstructed text must not replace raw state' }],
      }],
    }))
    expect(history).toEqual([raw])
  })

  it('removes legacy native compaction state from reconstructed replay', () => {
    const answer = {
      type: 'message',
      id: 'answer-1',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
    }
    const history = appServerHistory(options({
      messages: [{
        id: MessageId('assistant-1'),
        role: 'assistant',
        source: {
          kind: 'model',
          provider: 'codex-local',
          model: 'gpt-5.6-sol',
          replayState: {
            kind: 'codex-app-server',
            version: 1,
            items: [
              { type: 'compaction', encrypted_content: 'opaque' },
              { type: 'context_compaction', encrypted_content: 'opaque-context' },
              answer,
            ],
            contextItems: [],
          },
        },
        content: [{ type: 'text', text: 'answer' }],
      }],
    }))

    expect(history).toEqual([answer])
  })

  it('coalesces cumulative replay snapshots while preserving Harness results', () => {
    const callId = CallId('call-1')
    const firstReasoning = {
      type: 'reasoning',
      id: 'reasoning-1',
      summary: [],
      content: null,
      encrypted_content: 'first-encoding',
    }
    const latestReasoning = {
      type: 'reasoning',
      id: 'reasoning-1',
      summary: [],
      encrypted_content: 'latest-encoding',
    }
    const call = {
      type: 'function_call',
      call_id: String(callId),
      name: 'read_file',
      arguments: '{"path":"a.txt"}',
    }
    const secondReasoning = {
      type: 'reasoning',
      id: 'reasoning-2',
      summary: [],
      encrypted_content: 'second',
    }
    const source = (items: Record<string, unknown>[]) => ({
      kind: 'model' as const,
      provider: 'codex-local',
      model: 'gpt-5.6-sol',
      replayState: { kind: 'codex-app-server', version: 1, items, contextItems: [] },
    })

    const history = appServerHistory(options({
      messages: [
        {
          id: MessageId('assistant-1'),
          role: 'assistant',
          source: source([firstReasoning, call]),
          content: [{ type: 'tool-call', id: callId, name: 'read_file', arguments: call.arguments }],
        },
        {
          id: MessageId('tool-1'),
          role: 'user',
          source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: 'Harness result' }],
          }],
        },
        {
          id: MessageId('assistant-2'),
          role: 'assistant',
          source: source([
            latestReasoning,
            call,
            { type: 'function_call_output', call_id: String(callId), output: 'provider echo' },
            secondReasoning,
          ]),
          content: [{ type: 'text', text: 'done' }],
        },
      ],
    }))

    expect(history).toEqual([
      latestReasoning,
      call,
      { type: 'function_call_output', call_id: String(callId), output: 'Harness result' },
      secondReasoning,
    ])
  })

  it('advances the synchronized history without replacing Harness tool results', () => {
    const history = [
      { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'old' },
      { type: 'function_call_output', call_id: 'call-1', output: 'Harness result' },
    ]

    expect(extendAppServerHistory(history, [
      { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'new' },
      { type: 'function_call_output', call_id: 'call-1', output: 'provider echo' },
      { type: 'message', id: 'answer-1', role: 'assistant', content: [] },
    ])).toEqual([
      { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'new' },
      { type: 'function_call_output', call_id: 'call-1', output: 'Harness result' },
      { type: 'message', id: 'answer-1', role: 'assistant', content: [] },
    ])
  })

  it('extracts exact successful and failed Harness tool outcomes', () => {
    const first = CallId('call-1')
    const second = CallId('call-2')
    expect(appServerToolResults(options({
      messages: [{
        id: MessageId('tool-results'),
        role: 'user',
        source: { kind: 'tool', callId: first },
        content: [
          {
            type: 'tool-result',
            toolCallId: first,
            content: [{ type: 'text', text: 'ok' }],
          },
          {
            type: 'tool-result',
            toolCallId: second,
            content: [{ type: 'text', text: 'broken' }],
            isError: true,
          },
        ],
      }],
    }))).toEqual([
      { callId: 'call-1', output: 'ok', success: true },
      { callId: 'call-2', output: 'Tool error:\nbroken', success: false },
    ])
  })

  it('ignores null-versus-absent changes in injected raw item echoes', () => {
    const injected = {
      type: 'reasoning',
      id: 'reasoning-1',
      summary: [],
      content: null,
      encrypted_content: 'opaque',
    }
    const mapper = new AppServerEventMapper([injected])
    const echoed: CodexAppServerEvent = {
      kind: 'notification',
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'reasoning',
          id: 'reasoning-1',
          summary: [],
          encrypted_content: 'opaque',
        },
      },
    }

    expect(mapper.accept(echoed)).toEqual([])
    expect(mapper.replayState()).toEqual({
      kind: 'codex-app-server',
      version: 1,
      items: [],
      contextItems: [],
    })
  })

  it('separates injected history, Codex context, and outputs across raw responses', () => {
    const injected = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    }
    const mapper = new AppServerEventMapper([injected])
    const raw = (item: Record<string, unknown>): CodexAppServerEvent => ({
      kind: 'notification',
      method: 'rawResponseItem/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item },
    })
    const context = {
      type: 'message',
      id: 'context-1',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Codex context' }],
    }
    const first = {
      type: 'message',
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first' }],
    }
    const second = {
      type: 'message',
      id: 'assistant-2',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second' }],
    }

    expect(mapper.accept(raw({
      ...injected,
      id: 'provider-added-id',
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
    }))).toEqual([])
    expect(mapper.accept(raw(context))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'block-end', block: expect.objectContaining({
        type: 'codex-action',
        actionType: 'context/injected',
        category: 'context',
      }) }),
    ]))
    expect(mapper.accept(raw(first))).toEqual([])
    mapper.accept({
      kind: 'notification',
      method: 'rawResponse/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', usage: null },
    })
    expect(mapper.accept(raw({ ...context, id: 'context-2' }))).toEqual([])
    expect(mapper.accept(raw(first))).toEqual([])
    expect(mapper.accept(raw(second))).toEqual([])

    expect(mapper.replayState()).toEqual({
      kind: 'codex-app-server',
      version: 1,
      items: [first, second],
      contextItems: [context],
    })
  })

  it.each(['compaction', 'compaction_trigger', 'context_compaction'])(
    'marks a raw %s item as non-reconstructible provider trajectory',
    (type) => {
      const mapper = new AppServerEventMapper()
      mapper.accept({
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type, encrypted_content: 'opaque' },
        },
      })

      expect(mapper.canReuseThread()).toBe(false)
      expect(mapper.replayState().items).toEqual([])
    },
  )

  it('marks a native thread compaction notification as non-reusable', () => {
    const mapper = new AppServerEventMapper()
    mapper.accept({
      kind: 'notification',
      method: 'thread/compacted',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    })
    expect(mapper.canReuseThread()).toBe(false)
  })

  it('maps the exact Harness catalog to dynamic tools', () => {
    expect(appServerDynamicTools([{
      name: 'read_file',
      description: 'Read one file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    }])).toEqual([{
      type: 'function',
      name: 'read_file',
      description: 'Read one file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    }])
  })

  it('accepts only offered object-valued dynamic calls', () => {
    const event: Extract<CodexAppServerEvent, { kind: 'server-request' }> = {
      kind: 'server-request',
      id: 7,
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
    }
    const tools = [{ name: 'read_file', description: 'Read.', parameters: { type: 'object' } }]
    expect(harnessToolCall(event, tools)).toEqual({
      id: 'call-1',
      name: 'read_file',
      arguments: '{"path":"a.txt"}',
    })
    expect(() => harnessToolCall({ ...event, params: { ...event.params, tool: 'shell' } }, tools))
      .toThrowError(expect.objectContaining({ code: 'UNKNOWN_TOOL' }))
    expect(() => harnessToolCall({ ...event, params: { ...event.params, arguments: 'not-an-object' } }, tools))
      .toThrowError(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })

  it('distinguishes successful completion from actual turn failure', () => {
    const completed: CodexAppServerEvent = {
      kind: 'notification',
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed', error: null } },
    }
    expect(() => assertCompletedTurn(completed)).not.toThrow()
    expect(() => assertCompletedTurn({
      ...completed,
      params: {
        turn: { id: 'turn-1', status: 'failed', error: { message: 'status 401 unauthorized' } },
      },
    })).toThrowError(expect.objectContaining({ code: 'AUTH' }))
  })

  it.each([
    ['maximum context length exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
    ['status 401 unauthorized', 'AUTH'],
    ['quota exceeded', 'QUOTA'],
    ['status 429 too many requests', 'RATE_LIMIT'],
    ['status 503 service unavailable', 'SERVER'],
    ['connection reset', 'TRANSPORT'],
  ])('classifies %s as %s', (message, code) => {
    expect(codexFailureCode(message)).toBe(code)
  })
})
