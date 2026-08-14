import { describe, expect, it } from 'vitest'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  appServerDynamicTools,
  appServerHistory,
  assertCompletedTurn,
  codexFailureCode,
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
          content: [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"a.txt"}' }],
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
          replayState: { kind: 'codex-app-server', version: 0, items: [raw] },
        },
        content: [{ type: 'text', text: 'reconstructed text must not replace raw state' }],
      }],
    }))
    expect(history).toEqual([raw])
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
