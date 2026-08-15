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
import type {
  CodexAppServerEvent,
  CodexAppServerToolResult,
  JsonValue,
} from './runner.ts'
import { HARNESS_TOOL_NAMESPACE } from './identifiers.ts'

const REPLAY_KIND = 'codex-app-server'
const REPLAY_VERSION = 3
const HARNESS_SKILL_NAME = 'skill'
const HARNESS_SKILL_TOOL_NAME = 'harness_skill'
const NATIVE_COMPACTION_ITEM_TYPES = new Set([
  'compaction',
  'compaction_trigger',
  'context_compaction',
])

interface JsonObject {
  readonly [key: string]: unknown
}

interface BridgedTool {
  readonly name: string
  readonly tool: ToolSchema
}

/** Logged Codex-owned lifecycle, context, action, or diagnostic snapshot. */
export interface CodexActionBlock {
  readonly type: 'codex-action'
  readonly actionId: string
  readonly actionType: string
  readonly category: 'lifecycle' | 'context' | 'action' | 'diagnostic'
  readonly phase: 'requested' | 'started' | 'updated' | 'completed' | 'failed' | 'declined'
  readonly protocolEvent: string
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
  readonly contextItems: readonly JsonValue[]
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

function jsonRecord(value: JsonValue, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LlmError(`${label} must be a JSON object`, 'INVALID_TOOL_SCHEMA')
  }
  return value
}

function appServerToolName(name: string): string {
  return name === HARNESS_SKILL_NAME ? HARNESS_SKILL_TOOL_NAME : name
}

function harnessSkillCatalogNames(messages: GenerateOptions['messages']): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const source = messages[index]!.source as unknown as {
      readonly kind?: unknown
      readonly form?: unknown
      readonly entries?: unknown
    }
    if (source.kind !== 'skill-catalog') continue
    if (source.form !== 'catalog' || !Array.isArray(source.entries)) {
      throw new LlmError('Harness history contains an invalid skill catalog', 'INVALID_HISTORY')
    }
    const names: string[] = []
    const seen = new Set<string>()
    for (const entry of source.entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
        || typeof (entry as { readonly name?: unknown }).name !== 'string'
        || (entry as { readonly name: string }).name.length === 0
        || seen.has((entry as { readonly name: string }).name)) {
        throw new LlmError('Harness history contains an invalid skill catalog entry', 'INVALID_HISTORY')
      }
      const name = (entry as { readonly name: string }).name
      seen.add(name)
      names.push(name)
    }
    return names
  }
  return []
}

function bridgedTools(
  tools: readonly ToolSchema[] | undefined,
  skillNames: readonly string[],
): BridgedTool[] {
  const bridged: BridgedTool[] = []
  const seen = new Set<string>()
  for (const tool of tools ?? []) {
    if (tool.name === HARNESS_SKILL_NAME && skillNames.length === 0) continue
    const name = appServerToolName(tool.name)
    if (seen.has(name)) {
      throw new LlmError(`Harness tool names collide after App Server mapping: ${JSON.stringify(name)}`, 'INVALID_TOOL_SCHEMA')
    }
    seen.add(name)
    bridged.push({ name, tool })
  }
  return bridged
}

function appServerToolSchema(tool: ToolSchema, skillNames: readonly string[]): JsonValue {
  const schema = jsonValue(tool.parameters, `schema for ${tool.name}`)
  if (tool.name !== HARNESS_SKILL_NAME) return schema
  const root = jsonRecord(schema, 'Harness skill tool schema')
  const properties = jsonRecord(root.properties!, 'Harness skill tool schema properties')
  const name = jsonRecord(properties.name!, 'Harness skill name schema')
  return {
    ...root,
    properties: {
      ...properties,
      name: { ...name, enum: [...skillNames] },
    },
  }
}

function replayItems(value: unknown): JsonValue[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as JsonObject
  if (candidate.kind !== REPLAY_KIND
    || candidate.version !== REPLAY_VERSION
    || !Array.isArray(candidate.items)
    || !Array.isArray(candidate.contextItems)) {
    return undefined
  }
  candidate.contextItems.forEach((item, index) => { jsonValue(item, `replayState.contextItems[${index}]`) })
  return candidate.items
    .map((item, index) => jsonValue(item, `replayState.items[${index}]`))
    .filter(item => !isNativeCompactionItem(item))
}

function isNativeCompactionItem(value: JsonValue): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.type === 'string'
    && NATIVE_COMPACTION_ITEM_TYPES.has(value.type)
}

const FINGERPRINT_IGNORED_KEYS = new Set([
  'internal_chat_message_metadata_passthrough',
  'phase',
  'status',
])

function normalizedFingerprintValue(value: JsonValue, loose: boolean): JsonValue {
  if (Array.isArray(value)) return value.map(entry => normalizedFingerprintValue(entry, loose))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    const entry = value[key]!
    if (entry === null || FINGERPRINT_IGNORED_KEYS.has(key) || (loose && key === 'id')) return []
    return [[key, normalizedFingerprintValue(entry, loose)]]
  }))
}

function fingerprint(value: JsonValue, loose: boolean): string {
  return JSON.stringify(normalizedFingerprintValue(value, loose))
}

function hasResponseItemId(value: JsonValue): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.id === 'string'
}

interface ResponseItem {
  readonly [key: string]: JsonValue
  readonly type: string
}

function responseItem(value: unknown, label: string): ResponseItem {
  const candidate = jsonValue(value, label)
  if (candidate === null
    || typeof candidate !== 'object'
    || Array.isArray(candidate)
    || typeof candidate.type !== 'string') {
    throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  return candidate as ResponseItem
}

function responseItemIdentity(value: JsonValue): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') {
    return undefined
  }
  if (typeof value.id === 'string' && value.id.length > 0) {
    return JSON.stringify([value.type, 'id', value.id])
  }
  if (typeof value.call_id === 'string' && value.call_id.length > 0) {
    return JSON.stringify([value.type, 'call_id', value.call_id])
  }
  return undefined
}

type HistoryItemOrigin = 'harness' | 'provider'

interface HistoryIdentitySlot {
  readonly index: number
  readonly origin: HistoryItemOrigin
}

function appendHistoryItem(
  history: JsonValue[],
  identities: Map<string, HistoryIdentitySlot>,
  item: JsonValue,
  origin: HistoryItemOrigin,
): void {
  const identity = responseItemIdentity(item)
  if (identity === undefined) {
    history.push(item)
    return
  }
  const previous = identities.get(identity)
  if (previous === undefined) {
    identities.set(identity, { index: history.length, origin })
    history.push(item)
    return
  }
  if (previous.origin === 'harness' && origin === 'provider') return
  history[previous.index] = item
  identities.set(identity, { index: previous.index, origin })
}

function rawItemDisposition(value: ResponseItem): 'context' | 'replay' | 'trajectory' {
  if (value.type === 'message') return value.role === 'assistant' ? 'replay' : 'context'
  return NATIVE_COMPACTION_ITEM_TYPES.has(value.type) ? 'trajectory' : 'replay'
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
  const identities = new Map<string, HistoryIdentitySlot>()
  const append = (item: JsonValue, origin: HistoryItemOrigin): void => {
    appendHistoryItem(history, identities, item, origin)
  }
  for (const message of options.messages) {
    const replay = message.role === 'assistant'
      && message.source.kind === 'model'
      && message.source.provider === options.provider
      ? replayItems(message.source.replayState)
      : undefined
    if (replay !== undefined) {
      for (const item of replay) append(item, 'provider')
      continue
    }
    let text: string[] = []
    const flushText = (): void => {
      if (text.length === 0) return
      append(encodedHistoryMessage(message.role, text.join('\n')), 'harness')
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
          // Provider trajectory is durable presentation metadata, not assistant-authored history.
          break
        case 'tool-call':
          flushText()
          append({
            type: 'function_call',
            call_id: String(block.id),
            namespace: HARNESS_TOOL_NAMESPACE,
            name: appServerToolName(block.name),
            arguments: argumentsJson(block.arguments, `arguments for ${block.name}`),
          }, 'harness')
          break
        case 'tool-result':
          flushText()
          append({
            type: 'function_call_output',
            call_id: String(block.toolCallId),
            output: resultOutput(block),
          }, 'harness')
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

function existingHistoryOrigin(item: JsonValue): HistoryItemOrigin {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return 'provider'
  if (item.type === 'function_call_output') return 'harness'
  if (item.type === 'function_call' && item.namespace === HARNESS_TOOL_NAMESPACE) return 'harness'
  if (item.type === 'message' && item.role !== 'assistant') return 'harness'
  return 'provider'
}

/** Append newly logged provider outputs using the same identities as request reconstruction. */
export function extendAppServerHistory(
  history: readonly JsonValue[],
  outputs: readonly JsonValue[],
): JsonValue[] {
  const extended: JsonValue[] = []
  const identities = new Map<string, HistoryIdentitySlot>()
  for (const item of history) appendHistoryItem(extended, identities, item, existingHistoryOrigin(item))
  for (const item of outputs) appendHistoryItem(extended, identities, item, 'provider')
  return extended
}

/** Extract logged Harness tool outcomes for exact App Server callback continuation. */
export function appServerToolResults(options: GenerateOptions): CodexAppServerToolResult[] {
  return options.messages.flatMap(message => message.content.flatMap((block): CodexAppServerToolResult[] => {
    if (block.type !== 'tool-result') return []
    return [{
      callId: String(block.toolCallId),
      output: resultOutput(block),
      success: block.isError !== true,
    }]
  }))
}

/** Translate available Harness tools to App Server dynamic tools. */
export function appServerDynamicTools(
  tools: readonly ToolSchema[] | undefined,
  messages: GenerateOptions['messages'] = [],
): JsonValue[] {
  const skillNames = harnessSkillCatalogNames(messages)
  const declared = bridgedTools(tools, skillNames)
  if (declared.length === 0) return []
  return [{
    type: 'namespace',
    name: HARNESS_TOOL_NAMESPACE,
    description: declared.some(({ tool }) => tool.name === HARNESS_SKILL_NAME)
      ? 'Tools provided by the outer DeepSeek Harness agent loop. The harness_skill alias loads only names from the Harness session catalog; use Codex native skill support for Codex skills.'
      : 'Tools provided by the outer DeepSeek Harness agent loop.',
    tools: declared.map(({ name, tool }) => ({
      type: 'function',
      name,
      description: tool.name === HARNESS_SKILL_NAME
        ? `${tool.description} This App Server alias is only for the outer Harness session catalog, not Codex-native skills.`
        : tool.description,
      inputSchema: appServerToolSchema(tool, skillNames),
    })),
  }]
}

/** Decode one App Server dynamic callback without executing it in the provider. */
export function harnessToolCall(
  event: Extract<CodexAppServerEvent, { kind: 'server-request' }>,
  tools: readonly ToolSchema[] | undefined,
  messages: GenerateOptions['messages'] = [],
): HarnessToolCall {
  if (event.method !== 'item/tool/call') {
    throw new LlmError(`Expected a dynamic tool call, received ${event.method}`, 'MALFORMED_RESPONSE')
  }
  const params = event.params
  if (typeof params.callId !== 'string' || params.callId.length === 0
    || typeof params.tool !== 'string' || params.tool.length === 0) {
    throw new LlmError('Codex App Server returned an invalid dynamic tool call', 'MALFORMED_RESPONSE')
  }
  if (params.namespace !== HARNESS_TOOL_NAMESPACE) {
    throw new LlmError('Codex requested a tool outside the DeepSeek Harness namespace', 'UNKNOWN_TOOL')
  }
  const skillNames = harnessSkillCatalogNames(messages)
  const offered = new Map(bridgedTools(tools, skillNames).map(({ name, tool }) => [name, tool.name]))
  const originalName = offered.get(params.tool)
  if (originalName === undefined) {
    throw new LlmError(`Codex requested unavailable Harness tool "${params.tool}"`, 'UNKNOWN_TOOL')
  }
  const args = object(params.arguments, `arguments for ${params.tool}`)
  if (originalName === HARNESS_SKILL_NAME
    && (typeof args.name !== 'string' || !skillNames.includes(args.name))) {
    throw new LlmError('Codex requested a skill outside the current Harness session catalog', 'UNKNOWN_TOOL')
  }
  return {
    id: CallId(params.callId),
    name: originalName,
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

const ACTION_NOTIFICATION_METHODS = new Set([
  'hook/started',
  'hook/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'thread/compacted',
])

const DIAGNOSTIC_NOTIFICATION_METHODS = new Set([
  'error',
  'serverRequest/resolved',
  'model/rerouted',
  'model/verification',
  'model/safetyBuffering/updated',
  'turn/moderationMetadata',
  'warning',
  'guardianWarning',
  'deprecationNotice',
  'configWarning',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
])

const RAW_REQUEST_ITEM_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'tool_search_call',
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

function terminalActionPhase(
  status: unknown,
  fallback: CodexActionBlock['phase'],
): CodexActionBlock['phase'] {
  if (status === 'failed') return 'failed'
  if (status === 'declined' || status === 'cancelled' || status === 'canceled') return 'declined'
  return fallback
}

function rawActionPhase(value: ResponseItem): CodexActionBlock['phase'] {
  if (RAW_REQUEST_ITEM_TYPES.has(value.type)) {
    return terminalActionPhase(value.status, 'requested')
  }
  if (value.status === 'inProgress' || value.status === 'in_progress') return 'started'
  return terminalActionPhase(value.status, 'completed')
}

type RetainedRawItem =
  | { readonly kind: 'known' }
  | { readonly kind: 'context' | 'output' | 'trajectory'; readonly item: ResponseItem }

/** Stateful conversion of one App Server turn to indexed Harness blocks and replay data. */
export class AppServerEventMapper {
  private readonly open = new Map<string, OpenTextBlock>()
  private readonly initialHistory: readonly JsonValue[]
  private readonly harnessToolNames: ReadonlySet<string>
  private readonly rawItems: JsonValue[] = []
  private readonly contextItems: JsonValue[] = []
  private readonly contextFingerprints = new Set<string>()
  private exactBaseline = new Map<string, number>()
  private looseBaseline = new Map<string, number>()
  private readonly accumulatedUsage: UsageAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  private fallbackUsage: UsageAccumulator | undefined
  private rawUsageSeen = false
  private nativeCompactionSeen = false
  private nextIndex = 0
  private nextRawAction = 0

  constructor(history: readonly JsonValue[] = [], harnessToolNames: readonly string[] = []) {
    this.initialHistory = history.map((item, index) => jsonValue(item, `history[${index}]`))
    this.harnessToolNames = new Set(harnessToolNames.map(appServerToolName))
    this.resetBaseline()
  }

  private resetBaseline(): void {
    this.exactBaseline = new Map()
    this.looseBaseline = new Map()
    for (const candidate of [...this.initialHistory, ...this.rawItems]) {
      const counts = hasResponseItemId(candidate) ? this.exactBaseline : this.looseBaseline
      const key = fingerprint(candidate, !hasResponseItemId(candidate))
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  private consumeBaseline(candidate: JsonValue): boolean {
    const exact = fingerprint(candidate, false)
    const exactCount = this.exactBaseline.get(exact) ?? 0
    if (exactCount > 0) {
      this.exactBaseline.set(exact, exactCount - 1)
      return true
    }
    const loose = fingerprint(candidate, true)
    const looseCount = this.looseBaseline.get(loose) ?? 0
    if (looseCount > 0) {
      this.looseBaseline.set(loose, looseCount - 1)
      return true
    }
    return false
  }

  private retainRawItem(value: unknown): RetainedRawItem {
    const candidate = responseItem(value, `raw response item ${this.rawItems.length + this.contextItems.length}`)
    if (this.consumeBaseline(candidate)) return { kind: 'known' }
    if (NATIVE_COMPACTION_ITEM_TYPES.has(candidate.type)) this.nativeCompactionSeen = true
    const disposition = rawItemDisposition(candidate)
    if (disposition === 'replay') {
      this.rawItems.push(candidate)
      return { kind: 'output', item: candidate }
    }
    if (disposition === 'trajectory') return { kind: 'trajectory', item: candidate }
    const key = fingerprint(candidate, true)
    if (this.contextFingerprints.has(key)) return { kind: 'known' }
    this.contextFingerprints.add(key)
    this.contextItems.push(candidate)
    return { kind: 'context', item: candidate }
  }

  private rawActionId(value: ResponseItem, params: JsonObject): string {
    if (typeof value.call_id === 'string' && value.call_id.length > 0) return value.call_id
    if (typeof value.id === 'string' && value.id.length > 0) return value.id
    const turn = typeof params.turnId === 'string' ? params.turnId : 'raw-response'
    return `${turn}:${String(this.nextRawAction++)}`
  }

  private rawItemAction(params: JsonObject): StreamChunk[] {
    const retained = this.retainRawItem(params.item)
    if (retained.kind === 'known') return []
    const current = retained.item
    if (retained.kind === 'context') {
      return this.action(
        this.rawActionId(current, params),
        'context/injected',
        'context',
        'completed',
        'rawResponseItem/completed',
        current,
      )
    }
    if (current.type === 'message' || current.type === 'reasoning') return []
    if (RAW_REQUEST_ITEM_TYPES.has(current.type)
      && current.namespace === HARNESS_TOOL_NAMESPACE
      && typeof current.name === 'string'
      && this.harnessToolNames.has(current.name)) {
      return []
    }
    return this.action(
      this.rawActionId(current, params),
      current.type,
      'action',
      rawActionPhase(current),
      'rawResponseItem/completed',
      current,
    )
  }

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
    category: CodexActionBlock['category'],
    phase: CodexActionBlock['phase'],
    protocolEvent: string,
    snapshot: unknown,
  ): StreamChunk[] {
    return this.atomicBlock({
      type: 'codex-action',
      actionId,
      actionType,
      category,
      phase,
      protocolEvent,
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
      return this.action(event.threadId, 'thread/start', 'lifecycle', 'completed', 'thread/start', {
        threadId: event.threadId,
        userAgent: event.userAgent,
        instructionSources: event.instructionSources,
        ownership: 'layered',
        codexOwnedPromptAndTools: true,
      })
    }
    if (event.kind === 'server-request') {
      if (event.method === 'item/tool/call'
        && event.params.namespace === HARNESS_TOOL_NAMESPACE) return []
      const actionId = typeof event.params.itemId === 'string' ? event.params.itemId : String(event.id)
      return this.action(
        actionId,
        event.method,
        'action',
        event.resolution === 'answered' ? 'completed' : 'declined',
        event.method,
        {
          params: event.params,
          resolution: event.resolution,
        },
      )
    }
    const { method, params } = event
    if (method === 'thread/compacted') this.nativeCompactionSeen = true
    if (method === 'rawResponseItem/completed') {
      return this.rawItemAction(params)
    }
    if (method === 'rawResponse/completed') {
      this.addUsage(params.usage, true)
      this.resetBaseline()
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
      return this.action(
        current.id,
        current.type,
        'action',
        method === 'item/started' ? 'started' : terminalActionPhase(current.status, 'completed'),
        method,
        current,
      )
    }
    if (method.startsWith('item/')
      || method.startsWith('command/')
      || method.startsWith('process/')
      || ACTION_NOTIFICATION_METHODS.has(method)
      || DIAGNOSTIC_NOTIFICATION_METHODS.has(method)) {
      const actionId = typeof params.itemId === 'string'
        ? params.itemId
        : typeof params.turnId === 'string'
          ? params.turnId
          : method
      return this.action(
        actionId,
        method,
        DIAGNOSTIC_NOTIFICATION_METHODS.has(method) ? 'diagnostic' : 'action',
        'updated',
        method,
        params,
      )
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
        && candidate.namespace === HARNESS_TOOL_NAMESPACE
    })
    if (!present) {
      this.rawItems.push({
        type: 'function_call',
        call_id: String(call.id),
        namespace: HARNESS_TOOL_NAMESPACE,
        name: appServerToolName(call.name),
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

  /** Whether the live thread still has only reconstructible Harness-owned history. */
  canReuseThread(): boolean {
    return !this.nativeCompactionSeen
  }

  /** Snapshot raw provider items so the next Harness request can inject them. */
  replayState(): CodexReplayState {
    return {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      items: [...this.rawItems],
      contextItems: [...this.contextItems],
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
