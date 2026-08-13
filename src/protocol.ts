/** Codex JSONL and prompt translation for the Harness LLM adapter. */

import {
  CallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'

interface JsonObject {
  readonly [key: string]: unknown
}

interface BridgeToolCall {
  readonly name: string
  readonly arguments: string
}

export type BridgeResponse =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'tool_calls'; readonly calls: readonly BridgeToolCall[] }

export interface ParsedCodexOutput {
  readonly response: BridgeResponse
  readonly usage?: TokenUsage
  readonly threadId?: string
}

const BRIDGE_INSTRUCTIONS = `You are serving as the language-model backend for DeepSeek Harness.
Treat the JSON request below as the complete conversation request. Follow its system text and ordered messages.
Do not inspect files, execute commands, browse, call MCP, use skills, or use any Codex-native tool.
Harness tools are descriptions only. Never execute or simulate them. To request them, return kind "tool_calls" and put each exact tool name and a JSON object serialized as the arguments string in calls. Use an empty text string.
To answer the user, return kind "message", a non-empty text reply, and an empty calls array.
Return only the object required by the output schema.`

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LlmError(`Codex returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  return value as number
}

function encodeBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: String(block.id),
        name: block.name,
        arguments: block.arguments,
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: String(block.toolCallId),
        content: block.content.map(encodeBlock),
        isError: block.isError === true,
      }
    case 'image':
      throw new LlmError('Codex CLI bridge supports text input only', 'UNSUPPORTED_CONTENT')
    default:
      throw new LlmError(
        `Codex CLI bridge does not support content block ${JSON.stringify((block as { type?: unknown }).type)}`,
        'UNSUPPORTED_CONTENT',
      )
  }
}

function encodeTools(tools: readonly ToolSchema[] | undefined): unknown[] {
  return (tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

/** Serialize exactly one Harness request into the Codex bridge prompt. */
export function buildBridgePrompt(options: GenerateOptions): string {
  const request = {
    system: options.system ?? '',
    messages: options.messages.map(message => ({
      role: message.role,
      content: message.content.map(encodeBlock),
    })),
    tools: encodeTools(options.tools),
  }
  return `${BRIDGE_INSTRUCTIONS}\n\nHARNESS_REQUEST_JSON\n${JSON.stringify(request)}`
}

function mapUsage(value: unknown): TokenUsage | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new LlmError('Codex returned invalid usage', 'MALFORMED_RESPONSE')
  const totalInput = integer(value.input_tokens, 'usage.input_tokens')
  const cacheRead = integer(value.cached_input_tokens ?? 0, 'usage.cached_input_tokens')
  const cacheWrite = integer(value.cache_write_input_tokens ?? 0, 'usage.cache_write_input_tokens')
  const output = integer(value.output_tokens, 'usage.output_tokens')
  const reasoning = integer(value.reasoning_output_tokens ?? 0, 'usage.reasoning_output_tokens')
  if (cacheRead + cacheWrite > totalInput) {
    throw new LlmError('Codex cached input exceeds total input usage', 'MALFORMED_RESPONSE')
  }
  return {
    inputTokens: totalInput - cacheRead - cacheWrite,
    outputTokens: output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  }
}

function parseArguments(value: unknown, toolName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LlmError(`Codex returned invalid arguments for tool "${toolName}"`, 'MALFORMED_RESPONSE')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error: unknown) {
    throw new LlmError(`Codex returned non-JSON arguments for tool "${toolName}"`, 'MALFORMED_RESPONSE', { cause: error })
  }
  if (!isObject(parsed)) {
    throw new LlmError(`Codex returned non-object arguments for tool "${toolName}"`, 'MALFORMED_RESPONSE')
  }
  return value
}

function parseBridgeResponse(text: string, tools: readonly ToolSchema[] | undefined): BridgeResponse {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError('Codex final message was not bridge JSON', 'MALFORMED_RESPONSE', { cause: error })
  }
  if (!isObject(value) || !Array.isArray(value.calls) || typeof value.text !== 'string') {
    throw new LlmError('Codex final message did not match the bridge response fields', 'MALFORMED_RESPONSE')
  }
  if (value.kind === 'message') {
    if (value.text.trim().length === 0 || value.calls.length !== 0) {
      throw new LlmError('Codex returned an invalid message response', 'MALFORMED_RESPONSE')
    }
    return { kind: 'message', text: value.text }
  }
  if (value.kind !== 'tool_calls' || value.text !== '' || value.calls.length === 0) {
    throw new LlmError('Codex returned an invalid tool-call response', 'MALFORMED_RESPONSE')
  }
  const offered = new Set((tools ?? []).map(tool => tool.name))
  const calls = value.calls.map((candidate: unknown) => {
    if (!isObject(candidate) || typeof candidate.name !== 'string' || candidate.name.length === 0) {
      throw new LlmError('Codex returned an invalid tool call', 'MALFORMED_RESPONSE')
    }
    if (!offered.has(candidate.name)) {
      throw new LlmError(`Codex requested unavailable tool "${candidate.name}"`, 'UNKNOWN_TOOL')
    }
    return {
      name: candidate.name,
      arguments: parseArguments(candidate.arguments, candidate.name),
    }
  })
  return { kind: 'tool_calls', calls }
}

function errorMessage(event: JsonObject): string | undefined {
  if (event.type === 'error' && typeof event.message === 'string') return event.message
  if (event.type !== 'turn.failed' || !isObject(event.error)) return undefined
  return typeof event.error.message === 'string' ? event.error.message : JSON.stringify(event.error)
}

/** Classify a Codex diagnostic into Harness's stable LLM failure taxonomy. */
export function codexFailureCode(message: string): string {
  if (/context(?:\s|_|-)*(?:window|length).*(?:exceed|overflow)|too (?:long|large).*context/is.test(message)) {
    return CONTEXT_WINDOW_EXCEEDED_CODE
  }
  if (/unauthori[sz]ed|authentication|not logged in|login required|invalid.*token|status\D*40[13]/i.test(message)) {
    return 'AUTH'
  }
  if (/insufficient.*(?:quota|balance|credit)|(?:quota|usage limit).*(?:exceed|exhaust|reached)|out of (?:credit|budget)/i.test(message)) {
    return QUOTA_EXCEEDED_CODE
  }
  if (/rate.?limit|too many requests|usage limit|status\D*429/i.test(message)) return 'RATE_LIMIT'
  if (/status\D*5\d\d|server error|service unavailable/i.test(message)) return 'SERVER'
  if (/connection (?:reset|refused|closed)|network error|stream (?:disconnected|closed)|timed? out/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'CODEX_PROCESS'
}

/** Parse one complete `codex exec --json` stdout stream. */
export function parseCodexJsonl(
  stdout: string,
  tools: readonly ToolSchema[] | undefined,
): ParsedCodexOutput {
  let finalMessage: string | undefined
  let usage: TokenUsage | undefined
  let threadId: string | undefined
  let failure: string | undefined
  let completed = false
  let eventCount = 0

  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch (error: unknown) {
      throw new LlmError('Codex JSONL contained a malformed line', 'MALFORMED_RESPONSE', { cause: error })
    }
    if (!isObject(event) || typeof event.type !== 'string') {
      throw new LlmError('Codex JSONL contained an invalid event', 'MALFORMED_RESPONSE')
    }
    eventCount += 1
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id
    if (event.type === 'item.completed' && isObject(event.item) && event.item.type === 'agent_message') {
      if (typeof event.item.text !== 'string') {
        throw new LlmError('Codex returned an invalid agent message', 'MALFORMED_RESPONSE')
      }
      finalMessage = event.item.text
    }
    if (event.type === 'turn.completed') {
      completed = true
      usage = mapUsage(event.usage)
    }
    failure ??= errorMessage(event)
  }

  if (eventCount === 0) throw new LlmError('Codex returned no JSONL events', 'EMPTY_RESPONSE')
  if (failure !== undefined) throw new LlmError(failure, codexFailureCode(failure))
  if (!completed) throw new LlmError('Codex JSONL ended before turn.completed', 'TRANSPORT')
  if (finalMessage === undefined) throw new LlmError('Codex completed without an agent message', 'EMPTY_RESPONSE')
  return {
    response: parseBridgeResponse(finalMessage, tools),
    ...(usage === undefined ? {} : { usage }),
    ...(threadId === undefined ? {} : { threadId }),
  }
}

/** Convert a validated bridge result to one complete Harness chunk sequence. */
export function responseChunks(parsed: ParsedCodexOutput): StreamChunk[] {
  const chunks: StreamChunk[] = []
  if (parsed.response.kind === 'message') {
    const block = { type: 'text' as const, text: parsed.response.text }
    chunks.push(
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: parsed.response.text },
      { type: 'block-end', index: 0, block },
    )
  } else {
    parsed.response.calls.forEach((call, index) => {
      const id = CallId(crypto.randomUUID())
      const block = { type: 'tool-call' as const, id, name: call.name, arguments: call.arguments }
      chunks.push(
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments },
        { type: 'block-end', index, block },
      )
    })
  }
  if (parsed.usage !== undefined) chunks.push({ type: 'usage', usage: parsed.usage })
  chunks.push({
    type: 'finish',
    reason: { kind: parsed.response.kind === 'message' ? 'stop' : 'tool-calls' },
  })
  return chunks
}
