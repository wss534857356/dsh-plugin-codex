import { describe, expect, it } from 'vitest'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  buildBridgePrompt,
  codexFailureCode,
  parseCodexJsonl,
  responseChunks,
} from '../src/protocol.ts'

const tools: ToolSchema[] = [{
  name: 'read_file',
  description: 'Read one file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}]

function options(): GenerateOptions {
  return {
    provider: 'codex-local',
    model: 'gpt-5.6-sol',
    system: 'Answer tersely.',
    messages: [
      {
        id: MessageId('user-1'),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Read package.json' }],
      },
      {
        id: MessageId('assistant-1'),
        role: 'assistant',
        source: { kind: 'model', provider: 'codex-local', model: 'gpt-5.6-sol' },
        content: [{
          type: 'tool-call',
          id: CallId('call-1'),
          name: 'read_file',
          arguments: '{"path":"package.json"}',
        }],
      },
      {
        id: MessageId('tool-1'),
        role: 'user',
        source: { kind: 'tool', callId: CallId('call-1') },
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: '{"name":"demo"}' }],
          isError: false,
        }],
      },
    ],
    tools,
  }
}

function event(value: unknown): string {
  return JSON.stringify(value)
}

describe('bridge prompt', () => {
  it('serializes the logged system, messages, correlations, and tool schemas', () => {
    const prompt = buildBridgePrompt(options())
    const request = JSON.parse(prompt.slice(prompt.indexOf('\n{') + 1)) as Record<string, unknown>
    expect(request).toEqual({
      system: 'Answer tersely.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read package.json' }] },
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            id: 'call-1',
            name: 'read_file',
            arguments: '{"path":"package.json"}',
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: '{"name":"demo"}' }],
            isError: false,
          }],
        },
      ],
      tools,
    })
  })

  it('rejects image content before process startup', () => {
    const base = options()
    const request: GenerateOptions = {
      ...base,
      messages: [{
        ...base.messages[0]!,
        content: [{
          type: 'image',
          attachment: {
            attachmentId: 'sha256:deadbeef' as never,
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
        }],
      }],
    }
    expect(() => buildBridgePrompt(request)).toThrowError(/text input only/)
  })
})

describe('Codex JSONL parser', () => {
  it('parses a final message and disjoint token usage', () => {
    const stdout = [
      event({ type: 'thread.started', thread_id: 'thread-1' }),
      event({ type: 'turn.started' }),
      event({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '{"kind":"message","text":"done","calls":[]}',
        },
      }),
      event({
        type: 'turn.completed',
        usage: {
          input_tokens: 20,
          cached_input_tokens: 5,
          cache_write_input_tokens: 3,
          output_tokens: 4,
          reasoning_output_tokens: 2,
        },
      }),
    ].join('\n')
    const parsed = parseCodexJsonl(stdout, tools)
    expect(parsed).toEqual({
      response: { kind: 'message', text: 'done' },
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        reasoningTokens: 2,
      },
      threadId: 'thread-1',
    })
    expect(responseChunks(parsed)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'done' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      { type: 'usage', usage: parsed.usage },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('validates and emits Harness-owned tool calls', () => {
    const stdout = [
      event({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '{"kind":"tool_calls","text":"","calls":[{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}]}',
        },
      }),
      event({ type: 'turn.completed' }),
    ].join('\n')
    const chunks = responseChunks(parseCodexJsonl(stdout, tools))
    expect(chunks).toHaveLength(4)
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks[1]).toMatchObject({
      type: 'tool-call-delta',
      index: 0,
      name: 'read_file',
      argumentsDelta: '{"path":"README.md"}',
    })
    expect(chunks[2]).toMatchObject({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', name: 'read_file', arguments: '{"path":"README.md"}' },
    })
    expect(chunks[3]).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it.each([
    ['', 'EMPTY_RESPONSE'],
    ['not json', 'MALFORMED_RESPONSE'],
    [event({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }), 'EMPTY_RESPONSE'],
    [[
      event({ type: 'item.completed', item: { type: 'agent_message', text: '{}' } }),
      event({ type: 'turn.completed' }),
    ].join('\n'), 'MALFORMED_RESPONSE'],
    [[
      event({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '{"kind":"tool_calls","text":"","calls":[{"name":"missing","arguments":"{}"}]}',
        },
      }),
      event({ type: 'turn.completed' }),
    ].join('\n'), 'UNKNOWN_TOOL'],
  ])('rejects invalid output %#', (stdout, code) => {
    expect(() => parseCodexJsonl(stdout, tools)).toThrowError(expect.objectContaining({ code }))
  })

  it('surfaces in-band failures before partial answers', () => {
    const stdout = [
      event({
        type: 'item.completed',
        item: { type: 'agent_message', text: '{"kind":"message","text":"partial","calls":[]}' },
      }),
      event({ type: 'turn.failed', error: { message: 'authentication login required' } }),
    ].join('\n')
    expect(() => parseCodexJsonl(stdout, tools)).toThrowError(expect.objectContaining({ code: 'AUTH' }))
  })

  it('rejects a response whose terminal event was truncated', () => {
    const stdout = event({
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"kind":"message","text":"partial","calls":[]}' },
    })
    expect(() => parseCodexJsonl(stdout, tools)).toThrowError(expect.objectContaining({ code: 'TRANSPORT' }))
  })

  it('classifies stable provider failures conservatively', () => {
    expect(codexFailureCode('context window exceeded')).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(codexFailureCode('status 429: too many requests')).toBe('RATE_LIMIT')
    expect(codexFailureCode('insufficient quota')).toBe('QUOTA')
    expect(codexFailureCode('status 503')).toBe('SERVER')
    expect(codexFailureCode('stream disconnected before completion')).toBe('TRANSPORT')
    expect(codexFailureCode('unknown exit')).toBe('CODEX_PROCESS')
  })
})
