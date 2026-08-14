/** Disposable App Server thread leases keyed by Harness session identity. */

import { isDeepStrictEqual } from 'node:util'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  CodexAppServerEvent,
  CodexAppServerRunnerPort,
  CodexAppServerThreadPort,
  CodexAppServerThreadRequest,
  CodexAppServerToolResult,
  CodexAppServerTurnRequest,
  JsonValue,
} from './runner.ts'

const DISPOSE_REASON = Symbol('codex-session-cache-dispose')

type StableLeaseState =
  | { readonly kind: 'idle'; readonly history: readonly JsonValue[] }
  | { readonly kind: 'tool'; readonly history: readonly JsonValue[]; readonly callId: string }

type LeaseState = StableLeaseState | { readonly kind: 'active' } | { readonly kind: 'disposed' }

/** Values controlling bounded session-thread reuse. */
export interface CodexSessionCacheOptions {
  readonly runner: CodexAppServerRunnerPort
  readonly maxSessions: number
  readonly idleTimeoutMs: number
  readonly onCleanupError: (error: unknown) => void
}

/** One fully assembled Harness request offered to the session cache. */
export interface CodexSessionRequest {
  readonly sessionId: string
  readonly epoch: JsonValue
  readonly thread: Omit<CodexAppServerThreadRequest, 'signal'>
  readonly history: readonly JsonValue[]
  readonly reasoningEffort?: string
  readonly toolResults: readonly CodexAppServerToolResult[]
  readonly signal?: AbortSignal
}

/** Active cache step; exactly one terminal method must settle it. */
export interface CodexSessionStep {
  readonly events: AsyncIterable<CodexAppServerEvent>
  commit(history: readonly JsonValue[], pendingCallId?: string): void
  discard(): Promise<void>
}

function appendedItem(
  previous: readonly JsonValue[],
  current: readonly JsonValue[],
): JsonValue | undefined {
  if (current.length !== previous.length + 1) return undefined
  if (!previous.every((item, index) => isDeepStrictEqual(item, current[index]))) return undefined
  return current.at(-1)
}

function userInput(item: JsonValue | undefined): JsonValue[] | undefined {
  if (item === undefined || item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
  if (item.type !== 'message' || item.role !== 'user' || 'id' in item || !Array.isArray(item.content)) return undefined
  if (item.content.length !== 1) return undefined
  const content = item.content[0]
  if (content === null
    || typeof content !== 'object'
    || Array.isArray(content)
    || content.type !== 'input_text'
    || typeof content.text !== 'string') {
    return undefined
  }
  return [{ type: 'text', text: content.text, text_elements: [] }]
}

function matchingToolResult(
  item: JsonValue | undefined,
  callId: string,
  results: readonly CodexAppServerToolResult[],
): CodexAppServerToolResult | undefined {
  if (item === undefined || item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
  if (item.type !== 'function_call_output' || item.call_id !== callId || typeof item.output !== 'string') {
    return undefined
  }
  return results.find(result => result.callId === callId && result.output === item.output)
}

function coldTurn(request: CodexSessionRequest): CodexAppServerTurnRequest {
  return {
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    injectedItems: request.history,
    input: [],
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }
}

class SessionStep implements CodexSessionStep {
  private settled = false

  readonly events: AsyncIterable<CodexAppServerEvent>

  constructor(
    thread: CodexAppServerThreadPort,
    request: CodexAppServerTurnRequest,
    private readonly settle: (history: readonly JsonValue[], pendingCallId?: string) => void,
    private readonly retire: () => Promise<void>,
  ) {
    this.events = thread.stream(request)
  }

  commit(history: readonly JsonValue[], pendingCallId?: string): void {
    if (this.settled) throw new Error('Codex session step was already settled')
    this.settle(history, pendingCallId)
    this.settled = true
  }

  async discard(): Promise<void> {
    if (this.settled) return
    this.settled = true
    await this.retire()
  }
}

class SessionLease {
  private state: LeaseState = { kind: 'active' }
  private readonly lifetime = new AbortController()
  private readonly threadTask: Promise<CodexAppServerThreadPort>
  private disposeTask: Promise<void> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  lastUsed = 0

  constructor(
    readonly sessionId: string,
    readonly epoch: JsonValue,
    request: CodexSessionRequest,
    runner: CodexAppServerRunnerPort,
    private readonly idleTimeoutMs: number,
    private readonly touch: () => number,
    private readonly onIdle: (lease: SessionLease) => void,
    private readonly onSettled: () => void,
    private readonly retire: (lease: SessionLease) => Promise<void>,
  ) {
    const signal = request.signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([this.lifetime.signal, request.signal])
    this.threadTask = runner.open({ ...request.thread, signal })
  }

  get active(): boolean {
    return this.state.kind === 'active'
  }

  get evictable(): boolean {
    return this.state.kind === 'idle' || this.state.kind === 'tool'
  }

  async coldStep(request: CodexSessionRequest): Promise<CodexSessionStep> {
    const thread = await this.threadTask
    if (this.state.kind !== 'active') {
      throw new LlmError('Codex session lease was disposed while opening', 'ABORTED')
    }
    return this.step(thread, coldTurn(request))
  }

  async tryResume(request: CodexSessionRequest): Promise<CodexSessionStep | undefined> {
    if (this.state.kind === 'active') {
      throw new LlmError('Codex session already has an active model step', 'INVALID_CONTINUATION')
    }
    if (this.state.kind === 'disposed') return undefined
    const previous = this.state
    const suffix = appendedItem(previous.history, request.history)
    let turn: CodexAppServerTurnRequest | undefined
    if (previous.kind === 'idle') {
      const input = userInput(suffix)
      if (input !== undefined) {
        turn = {
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
          input,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }
      }
    } else {
      const toolResult = matchingToolResult(suffix, previous.callId, request.toolResults)
      if (toolResult !== undefined) {
        turn = {
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
          toolResult,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }
      }
    }
    if (turn === undefined) return undefined
    this.clearIdleTimer()
    this.state = { kind: 'active' }
    return this.step(await this.threadTask, turn)
  }

  private step(
    thread: CodexAppServerThreadPort,
    request: CodexAppServerTurnRequest,
  ): CodexSessionStep {
    return new SessionStep(
      thread,
      request,
      (history, pendingCallId) => { this.commit(history, pendingCallId) },
      () => this.retire(this),
    )
  }

  private commit(history: readonly JsonValue[], pendingCallId?: string): void {
    if (this.state.kind !== 'active') throw new Error('Codex session lease is not active')
    this.state = pendingCallId === undefined
      ? { kind: 'idle', history: [...history] }
      : { kind: 'tool', history: [...history], callId: pendingCallId }
    this.lastUsed = this.touch()
    this.idleTimer = setTimeout(() => { this.onIdle(this) }, this.idleTimeoutMs)
    this.onSettled()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  dispose(): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.state = { kind: 'disposed' }
    this.clearIdleTimer()
    this.lifetime.abort(DISPOSE_REASON)
    this.disposeTask = this.threadTask.then(thread => thread.dispose(), () => undefined)
    return this.disposeTask
  }
}

/** Bounded in-memory cache of disposable App Server session threads. */
export class CodexSessionCache {
  private readonly leases = new Map<string, SessionLease>()
  private clock = 0
  private disposed = false

  constructor(private readonly options: CodexSessionCacheOptions) {}

  /** Open or exactly continue the thread lease for one Harness request. */
  async begin(request: CodexSessionRequest): Promise<CodexSessionStep> {
    if (this.disposed) throw new LlmError('Codex session cache is disposed', 'ABORTED')
    let lease = this.leases.get(request.sessionId)
    if (lease !== undefined) {
      if (lease.active) {
        throw new LlmError('Codex session already has an active model step', 'INVALID_CONTINUATION')
      }
      if (isDeepStrictEqual(lease.epoch, request.epoch)) {
        const resumed = await lease.tryResume(request)
        if (resumed !== undefined) return resumed
      }
      await this.retire(lease)
      lease = undefined
    }
    await this.trimToSize(this.options.maxSessions - 1)
    const created = new SessionLease(
      request.sessionId,
      request.epoch,
      request,
      this.options.runner,
      this.options.idleTimeoutMs,
      () => ++this.clock,
      current => { this.expire(current) },
      () => { this.settled() },
      current => this.retire(current),
    )
    this.leases.set(request.sessionId, created)
    try {
      return await created.coldStep(request)
    } catch (error: unknown) {
      await this.retire(created)
      throw error
    }
  }

  /** Dispose the lease owned by one ended Harness session, when present. */
  async disposeSession(sessionId: string): Promise<void> {
    const lease = this.leases.get(sessionId)
    if (lease !== undefined) await this.retire(lease)
  }

  /** Dispose every lease and reject future requests. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const leases = [...this.leases.values()]
    this.leases.clear()
    const results = await Promise.allSettled(leases.map(lease => lease.dispose()))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'Codex session cache cleanup failed')
  }

  private async retire(lease: SessionLease): Promise<void> {
    if (this.leases.get(lease.sessionId) === lease) this.leases.delete(lease.sessionId)
    await lease.dispose()
  }

  private expire(lease: SessionLease): void {
    if (this.leases.get(lease.sessionId) !== lease || !lease.evictable) return
    void this.retire(lease).catch(this.options.onCleanupError)
  }

  private settled(): void {
    void this.trimToSize(this.options.maxSessions).catch(this.options.onCleanupError)
  }

  private async trimToSize(maxSize: number): Promise<void> {
    while (this.leases.size > maxSize) {
      const oldest = [...this.leases.values()]
        .filter(lease => lease.evictable)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0]
      if (oldest === undefined) return
      await this.retire(oldest)
    }
  }
}
