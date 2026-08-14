/** App Server history, event, and Harness stream translation. */

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
import type { CodexAppServerEvent, JsonValue } from './runner.ts'

const REPLAY_KIND = 'codex-app-server'
const REPLAY_VERSION = 0

interface JsonObject {
  readonly [key: string]: unknown
}

/** Logged provider-owned action or diagnostic snapshot. */
export interface CodexActionBlock {
  readonly type: 'codex-action'
  readonly actionId: string
  readonly actionType: string
  readonly phase: 'started' | 'updated' | 'completed'
  readonly snapshot: JsonValue
}

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'codex-action': CodexActionBlock
  }
}

/** Adapter state needed to reproduce one App Server response in a later request. */
export interface CodexReplayState {
  readonly kind: typeof REPLAY_KIND
  readonly version: typeof REPLAY_VERSION
  readonly items: readonly JsonValue[]
}

/** Validated Harness dynamic-tool call decoded from an App Server callback. */
export interface HarnessToolCall {
  readonly id: CallId
  readonly name: string
  readonly arguments: string
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  return value as JsonObject
}

function finiteInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  return value as number
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) {
    throw new LlmError(`Codex App Server ${label} usage overflowed`, 'MALFORMED_RESPONSE')
  }
  return result
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, `${label}.${key}`)]))
  }
  throw new LlmError(`Codex App Server returned non-JSON ${label}`, 'MALFORMED_RESPONSE')
}

function replayItems(value: unknown): JsonValue[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as JsonObject
  if (candidate.kind !== REPLAY_KIND || candidate.version !== REPLAY_VERSION || !Array.isArray(candidate.items)) {
    return undefined
  }
  return candidate.items.map((item, index) => jsonValue(item, `replayState.items[${index}]`))
}

function argumentsJson(value: string, label: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error: unknown) {
    throw new LlmError(`Codex history contains non-JSON ${label}`, 'MALFORMED_RESPONSE', { cause: error })
  }
  object(parsed, label)
  return value
}

function fallbackText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return `[reasoning]\n${block.text}`
    case 'codex-action':
      return `[codex-action]\n${JSON.stringify(block)}`
    case 'tool-call':
      return `[tool-call ${block.name}]\n${block.arguments}`
    case 'tool-result':
      return block.content.map(fallbackText).join('\n')
    case 'image':
      throw new LlmError('Codex App Server provider supports text input only', 'UNSUPPORTED_CONTENT')
    default:
      return `[${String((block as { type?: unknown }).type)}]\n${JSON.stringify(block)}`
  }
}

function resultOutput(block: Extract<ContentBlock, { type: 'tool-result' }>): string {
  const output = block.content.map(fallbackText).join('\n')
  return block.isError === true ? `Tool error:\n${output}` : output
}

function roleFor(role: GenerateOptions['messages'][number]['role']): string {
  return role === 'system' ? 'developer' : role
}

function encodedHistoryMessage(
  role: GenerateOptions['messages'][number]['role'],
  text: string,
): JsonValue {
  return {
    type: 'message',
    role: roleFor(role),
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  }
}

/** Reconstruct the App Server-visible conversation exclusively from the Harness request. */
export function appServerHistory(options: GenerateOptions): JsonValue[] {
  const history: JsonValue[] = []
  for (const message of options.messages) {
    const replay = message.role === 'assistant'
      && message.source.kind === 'model'
      && message.source.provider === options.provider
      ? replayItems(message.source.replayState)
      : undefined
    if (replay !== undefined) {
      history.push(...replay)
      continue
    }
    let text: string[] = []
    const flushText = (): void => {
      if (text.length === 0) return
      history.push(encodedHistoryMessage(message.role, text.join('\n')))
      text = []
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          text.push(block.text)
          break
        case 'reasoning':
          text.push(`[reasoning]\n${block.text}`)
          break
        case 'codex-action':
          text.push(`[codex-action]\n${JSON.stringify(block)}`)
          break
        case 'tool-call':
          flushText()
          history.push({
            type: 'function_call',
            call_id: String(block.id),
            name: block.name,
            arguments: argumentsJson(block.arguments, `arguments for ${block.name}`),
          })
          break
        case 'tool-result':
          flushText()
          history.push({
            type: 'function_call_output',
            call_id: String(block.toolCallId),
            output: resultOutput(block),
          })
          break
        case 'image':
          throw new LlmError('Codex App Server provider supports text input only', 'UNSUPPORTED_CONTENT')
        default:
          text.push(`[${String((block as { type?: unknown }).type)}]\n${JSON.stringify(block)}`)
      }
    }
    flushText()
  }
  return history
}

/** Translate the exact Harness tool catalog to App Server dynamic tools. */
export function appServerDynamicTools(tools: readonly ToolSchema[] | undefined): JsonValue[] {
  return (tools ?? []).map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    inputSchema: jsonValue(tool.parameters, `schema for ${tool.name}`),
  }))
}

/** Decode one App Server dynamic callback without executing it in the provider. */
export function harnessToolCall(
  event: Extract<CodexAppServerEvent, { kind: 'server-request' }>,
  tools: readonly ToolSchema[] | undefined,
): HarnessToolCall {
  if (event.method !== 'item/tool/call') {
    throw new LlmError(`Expected a dynamic tool call, received ${event.method}`, 'MALFORMED_RESPONSE')
  }
  const params = event.params
  if (typeof params.callId !== 'string' || params.callId.length === 0
    || typeof params.tool !== 'string' || params.tool.length === 0
    || params.namespace !== null) {
    throw new LlmError('Codex App Server returned an invalid dynamic tool call', 'MALFORMED_RESPONSE')
  }
  const offered = new Set((tools ?? []).map(tool => tool.name))
  if (!offered.has(params.tool)) {
    throw new LlmError(`Codex requested unavailable Harness tool "${params.tool}"`, 'UNKNOWN_TOOL')
  }
  object(params.arguments, `arguments for ${params.tool}`)
  return {
    id: CallId(params.callId),
    name: params.tool,
    arguments: JSON.stringify(params.arguments),
  }
}

interface OpenTextBlock {
  readonly index: number
  readonly type: 'text' | 'reasoning'
  text: string
}

interface UsageAccumulator {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

const NATIVE_ITEM_TYPES = new Set([
  'hookPrompt',
  'plan',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
])

const REPORT_NOTIFICATION_METHODS = new Set([
  'hook/started',
  'hook/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'thread/compacted',
  'model/rerouted',
  'model/verification',
  'model/safetyBuffering/updated',
  'warning',
  'guardianWarning',
  'deprecationNotice',
  'configWarning',
])

function item(value: unknown, label: string): JsonObject & { readonly type: string; readonly id: string } {
  const candidate = object(value, label)
  if (typeof candidate.type !== 'string' || typeof candidate.id !== 'string') {
    throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  return candidate as JsonObject & { readonly type: string; readonly id: string }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  return value as string[]
}

/** Stateful conversion of one App Server turn to indexed Harness blocks and replay data. */
export class AppServerEventMapper {
  private readonly open = new Map<string, OpenTextBlock>()
  private readonly rawItems: JsonValue[] = []
  private readonly accumulatedUsage: UsageAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  private fallbackUsage: UsageAccumulator | undefined
  private rawUsageSeen = false
  private nextIndex = 0

  private atomicBlock(block: ContentBlock): StreamChunk[] {
    const index = this.nextIndex++
    return [
      { type: 'block-start', index, blockType: block.type },
      ...(block.type === 'text'
        ? [{ type: 'text-delta' as const, index, text: block.text }]
        : block.type === 'reasoning'
          ? [{ type: 'reasoning-delta' as const, index, text: block.text }]
          : []),
      { type: 'block-end', index, block },
    ]
  }

  private action(
    actionId: string,
    actionType: string,
    phase: CodexActionBlock['phase'],
    snapshot: unknown,
  ): StreamChunk[] {
    return this.atomicBlock({
      type: 'codex-action',
      actionId,
      actionType,
      phase,
      snapshot: jsonValue(snapshot, `snapshot for ${actionType}`),
    })
  }

  private delta(key: string, type: OpenTextBlock['type'], text: string): StreamChunk[] {
    let state = this.open.get(key)
    const chunks: StreamChunk[] = []
    if (state === undefined) {
      state = { index: this.nextIndex++, type, text: '' }
      this.open.set(key, state)
      chunks.push({ type: 'block-start', index: state.index, blockType: type })
    }
    if (state.type !== type) throw new LlmError('Codex App Server reused an item id across block types', 'MALFORMED_RESPONSE')
    state.text += text
    chunks.push(type === 'text'
      ? { type: 'text-delta', index: state.index, text }
      : { type: 'reasoning-delta', index: state.index, text })
    return chunks
  }

  private close(key: string, completedText?: string): StreamChunk[] {
    const state = this.open.get(key)
    if (state === undefined) return []
    this.open.delete(key)
    const text = completedText ?? state.text
    return [{
      type: 'block-end',
      index: state.index,
      block: state.type === 'text' ? { type: 'text', text } : { type: 'reasoning', text },
    }]
  }

  private addUsage(value: unknown, raw: boolean): void {
    if (value === null || value === undefined) return
    const usage = object(value, 'token usage')
    const totalInput = finiteInteger(usage.inputTokens, 'usage.inputTokens')
    const cacheRead = finiteInteger(usage.cachedInputTokens ?? 0, 'usage.cachedInputTokens')
    const cacheWrite = finiteInteger(usage.cacheWriteInputTokens ?? 0, 'usage.cacheWriteInputTokens')
    if (cacheRead + cacheWrite > totalInput) {
      throw new LlmError('Codex cached input exceeds total input usage', 'MALFORMED_RESPONSE')
    }
    const decoded: UsageAccumulator = {
      inputTokens: totalInput - cacheRead - cacheWrite,
      outputTokens: finiteInteger(usage.outputTokens, 'usage.outputTokens'),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: finiteInteger(usage.reasoningOutputTokens ?? 0, 'usage.reasoningOutputTokens'),
    }
    if (!raw) {
      this.fallbackUsage = decoded
      return
    }
    this.rawUsageSeen = true
    this.accumulatedUsage.inputTokens = checkedAdd(
      this.accumulatedUsage.inputTokens,
      decoded.inputTokens,
      'input token',
    )
    this.accumulatedUsage.outputTokens = checkedAdd(
      this.accumulatedUsage.outputTokens,
      decoded.outputTokens,
      'output token',
    )
    this.accumulatedUsage.cacheReadTokens = checkedAdd(
      this.accumulatedUsage.cacheReadTokens,
      decoded.cacheReadTokens,
      'cache-read token',
    )
    this.accumulatedUsage.cacheWriteTokens = checkedAdd(
      this.accumulatedUsage.cacheWriteTokens,
      decoded.cacheWriteTokens,
      'cache-write token',
    )
    this.accumulatedUsage.reasoningTokens = checkedAdd(
      this.accumulatedUsage.reasoningTokens,
      decoded.reasoningTokens,
      'reasoning token',
    )
  }

  /** Translate one decoded event to zero or more immediately publishable chunks. */
  accept(event: CodexAppServerEvent): StreamChunk[] {
    if (event.kind === 'thread-started') {
      return this.action(event.threadId, 'thread/start', 'completed', {
        threadId: event.threadId,
        userAgent: event.userAgent,
        instructionSources: event.instructionSources,
        ownership: 'layered',
        codexOwnedPromptAndTools: true,
      })
    }
    if (event.kind === 'server-request') {
      if (event.method === 'item/tool/call') return []
      const actionId = typeof event.params.itemId === 'string' ? event.params.itemId : String(event.id)
      return this.action(actionId, event.method, 'completed', {
        params: event.params,
        resolution: event.resolution,
      })
    }
    const { method, params } = event
    if (method === 'rawResponseItem/completed') {
      this.rawItems.push(jsonValue(params.item, `raw response item ${this.rawItems.length}`))
      return []
    }
    if (method === 'rawResponse/completed') {
      this.addUsage(params.usage, true)
      return []
    }
    if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = object(params.tokenUsage, 'thread token usage')
      this.addUsage(tokenUsage.last, false)
      return []
    }
    if (method === 'item/agentMessage/delta') {
      if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') {
        throw new LlmError('Codex App Server returned an invalid agent message delta', 'MALFORMED_RESPONSE')
      }
      return this.delta(`message:${params.itemId}`, 'text', params.delta)
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') {
        throw new LlmError('Codex App Server returned an invalid reasoning delta', 'MALFORMED_RESPONSE')
      }
      const part = method === 'item/reasoning/summaryTextDelta'
        ? `summary:${finiteInteger(params.summaryIndex, 'reasoning summary index')}`
        : `content:${finiteInteger(params.contentIndex, 'reasoning content index')}`
      return this.delta(`reasoning:${params.itemId}:${part}`, 'reasoning', params.delta)
    }
    if (method === 'item/started' || method === 'item/completed') {
      const current = item(params.item, `${method} item`)
      if (current.type === 'agentMessage') {
        if (method === 'item/started') return []
        if (typeof current.text !== 'string') {
          throw new LlmError('Codex App Server returned an invalid completed agent message', 'MALFORMED_RESPONSE')
        }
        const closed = this.close(`message:${current.id}`, current.text)
        return closed.length > 0 || current.text.length === 0
          ? closed
          : this.atomicBlock({ type: 'text', text: current.text })
      }
      if (current.type === 'reasoning') {
        if (method === 'item/started') return []
        const prefix = `reasoning:${current.id}:`
        const keys = [...this.open.keys()].filter(key => key.startsWith(prefix))
        if (keys.length > 0) return keys.flatMap(key => this.close(key))
        const summary = stringArray(current.summary, 'completed reasoning summary')
        const content = stringArray(current.content, 'completed reasoning content')
        return [...summary, ...content].flatMap(text => this.atomicBlock({ type: 'reasoning', text }))
      }
      if (current.type === 'dynamicToolCall' || current.type === 'userMessage') return []
      if (NATIVE_ITEM_TYPES.has(current.type)) {
        return this.action(
          current.id,
          current.type,
          method === 'item/started' ? 'started' : 'completed',
          current,
        )
      }
      return this.action(current.id, current.type, method === 'item/started' ? 'started' : 'completed', current)
    }
    if (method.startsWith('item/')
      || method.startsWith('command/')
      || method.startsWith('process/')
      || REPORT_NOTIFICATION_METHODS.has(method)) {
      const actionId = typeof params.itemId === 'string'
        ? params.itemId
        : typeof params.turnId === 'string'
          ? params.turnId
          : method
      return this.action(actionId, method, 'updated', params)
    }
    return []
  }

  /** Close any delta block left open at a terminal protocol event. */
  closeOpen(): StreamChunk[] {
    return [...this.open.keys()].flatMap(key => this.close(key))
  }

  /** Emit one Harness-owned tool request and retain an injectable raw call item. */
  toolCall(call: HarnessToolCall): StreamChunk[] {
    const present = this.rawItems.some((candidate) => {
      return candidate !== null
        && typeof candidate === 'object'
        && !Array.isArray(candidate)
        && candidate.type === 'function_call'
        && candidate.call_id === String(call.id)
    })
    if (!present) {
      this.rawItems.push({
        type: 'function_call',
        call_id: String(call.id),
        name: call.name,
        arguments: call.arguments,
      })
    }
    const index = this.nextIndex++
    return [
      { type: 'block-start', index, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index,
        id: call.id,
        name: call.name,
        argumentsDelta: call.arguments,
      },
      { type: 'block-end', index, block: { type: 'tool-call', ...call } },
    ]
  }

  /** Return disjoint token accounting for the whole App Server turn when available. */
  usage(): TokenUsage | undefined {
    const source = this.rawUsageSeen ? this.accumulatedUsage : this.fallbackUsage
    if (source === undefined) return undefined
    return {
      inputTokens: source.inputTokens,
      outputTokens: source.outputTokens,
      ...(source.cacheReadTokens === 0 ? {} : { cacheReadTokens: source.cacheReadTokens }),
      ...(source.cacheWriteTokens === 0 ? {} : { cacheWriteTokens: source.cacheWriteTokens }),
      ...(source.reasoningTokens === 0 ? {} : { reasoningTokens: source.reasoningTokens }),
    }
  }

  /** Snapshot raw provider items so the next Harness request can inject them. */
  replayState(): CodexReplayState {
    return {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      items: [...this.rawItems],
    }
  }
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

/** Read the terminal turn status and raise only for an actual model/transport failure. */
export function assertCompletedTurn(event: CodexAppServerEvent): void {
  if (event.kind !== 'notification' || event.method !== 'turn/completed') {
    throw new LlmError('Expected Codex turn completion', 'MALFORMED_RESPONSE')
  }
  const turn = object(event.params.turn, 'turn/completed turn')
  if (turn.status === 'completed') return
  const error = turn.error === null || turn.error === undefined
    ? `Codex turn ended with status ${String(turn.status)}`
    : typeof object(turn.error, 'turn error').message === 'string'
      ? String(object(turn.error, 'turn error').message)
      : JSON.stringify(turn.error)
  throw new LlmError(error, turn.status === 'interrupted' ? 'ABORTED' : codexFailureCode(error))
}
