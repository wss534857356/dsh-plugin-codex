/** Serialized turn state for one open Codex App Server thread. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  CodexAppServerThreadPort,
  CodexAppServerTurnRequest,
} from './runner.ts'
import { HARNESS_TOOL_NAMESPACE, SAFE_REASONING_EFFORT } from './identifiers.ts'
import { JsonRpcConnection, jsonValue, object } from './wire.ts'
import type { CodexAppServerEvent } from './wire.ts'

const TIMEOUT_REASON = Symbol('codex-app-server-turn-timeout')

type PendingToolRequest = Extract<CodexAppServerEvent, { kind: 'server-request' }>

type ThreadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly turnId: string }
  | { readonly kind: 'tool'; readonly turnId: string; readonly request: PendingToolRequest }
  | { readonly kind: 'disposed' }

/** Construction values owned by the process factory. */
export interface ManagedCodexThreadOptions {
  readonly timeoutMs: number
  readonly connection: JsonRpcConnection
  readonly threadId: string
  readonly startedEvent: Extract<CodexAppServerEvent, { kind: 'thread-started' }>
  readonly abort: (reason: unknown) => void
  readonly dispose: () => Promise<void>
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Normalize one operation failure without losing timeout or caller cancellation. */
export function operationFailure(
  error: unknown,
  timedOut: boolean,
  caller: AbortSignal | undefined,
): LlmError {
  if (timedOut) return new LlmError('Codex App Server request timed out', 'TIMEOUT', { cause: error })
  if (caller?.aborted) return new LlmError('Codex App Server request aborted by caller', 'ABORTED', { cause: error })
  return error instanceof LlmError
    ? error
    : new LlmError('Codex App Server request failed', 'TRANSPORT', { cause: thrown(error) })
}

/** Validate the configurable fields sent at a turn boundary. */
export function validateTurnRequest(request: CodexAppServerTurnRequest): void {
  if (request.reasoningEffort !== undefined && !SAFE_REASONING_EFFORT.test(request.reasoningEffort)) {
    throw new LlmError(
      `Codex reasoning effort is not a safe identifier: ${JSON.stringify(request.reasoningEffort)}`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  for (const [groupIndex, group] of (request.steeringInputs ?? []).entries()) {
    if (group.length === 0) {
      throw new LlmError(`Codex steeringInputs[${String(groupIndex)}] is empty`, 'INVALID_CONTINUATION')
    }
    group.forEach((value, index) => {
      jsonValue(value, `steeringInputs[${String(groupIndex)}][${String(index)}]`)
    })
  }
  if (request.toolResult === undefined) return
  if (request.toolResult.callId.length === 0 || request.toolResult.contentItems.length === 0) {
    throw new LlmError('Codex tool result is incomplete', 'INVALID_CONTINUATION')
  }
  for (const [index, value] of request.toolResult.contentItems.entries()) {
    const item = object(value, `toolResult.contentItems[${index}]`)
    const validText = item.type === 'inputText' && typeof item.text === 'string'
    const validImage = item.type === 'inputImage'
      && typeof item.imageUrl === 'string'
      && /^data:image\/(?:png|jpeg|webp|gif);base64,/u.test(item.imageUrl)
    if (!validText && !validImage) {
      throw new LlmError(
        `Codex tool result contains invalid contentItems[${index}]`,
        'INVALID_CONTINUATION',
      )
    }
  }
}

function combinedFailure(primary: LlmError, cleanup: unknown): LlmError {
  const failure = thrown(cleanup)
  return new LlmError(`${primary.message}; cleanup also failed: ${failure.message}`, primary.code, {
    cause: new AggregateError([primary, failure], 'Codex App Server request and cleanup failed'),
  })
}

function threadId(value: unknown, label: string): string {
  const candidate = object(value, label)
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new LlmError(`Codex App Server returned invalid ${label}.id`, 'MALFORMED_RESPONSE')
  }
  return candidate.id
}

async function resolveServerRequest(
  connection: JsonRpcConnection,
  event: Extract<CodexAppServerEvent, { kind: 'server-request' }>,
): Promise<Extract<CodexAppServerEvent, { kind: 'server-request' }>> {
  switch (event.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      await connection.respond(event.id, { decision: 'decline' })
      return { ...event, resolution: 'declined' }
    case 'applyPatchApproval':
    case 'execCommandApproval':
      await connection.respond(event.id, { decision: { denied: { rejection: 'Harness did not approve this Codex action.' } } })
      return { ...event, resolution: 'declined' }
    case 'item/tool/requestUserInput':
      await connection.respond(event.id, { answers: {} })
      return { ...event, resolution: 'declined' }
    case 'mcpServer/elicitation/request':
      await connection.respond(event.id, { action: 'cancel', content: null, _meta: null })
      return { ...event, resolution: 'declined' }
    case 'currentTime/read':
      await connection.respond(event.id, { currentTimeAt: Math.floor(Date.now() / 1_000) })
      return { ...event, resolution: 'answered' }
    default:
      await connection.respondError(event.id, -32_001, `DeepSeek Harness cannot answer ${event.method}`)
      return { ...event, resolution: 'rejected' }
  }
}

/** Process-owned App Server thread with one serialized turn consumer. */
export class ManagedCodexThread implements CodexAppServerThreadPort {
  private state: ThreadState = { kind: 'idle' }
  private active = false
  private announced = false

  constructor(private readonly options: ManagedCodexThreadOptions) {}

  get threadId(): string {
    return this.options.threadId
  }

  async * stream(request: CodexAppServerTurnRequest): AsyncIterable<CodexAppServerEvent> {
    validateTurnRequest(request)
    if (this.active) {
      throw new LlmError('Codex App Server thread already has an active consumer', 'INVALID_CONTINUATION')
    }
    if (this.state.kind === 'disposed') {
      throw new LlmError('Codex App Server thread is disposed', 'INVALID_CONTINUATION')
    }
    this.active = true
    let retained = false
    let primary: LlmError | undefined
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      const failure = operationFailure(TIMEOUT_REASON, true, request.signal)
      this.options.connection.fail(failure)
      this.options.abort(TIMEOUT_REASON)
    }, this.options.timeoutMs)
    const onAbort = (): void => {
      const failure = operationFailure(request.signal?.reason, false, request.signal)
      this.options.connection.fail(failure)
      this.options.abort(request.signal?.reason)
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (request.signal?.aborted) throw request.signal.reason
      if (!this.announced) {
        this.announced = true
        yield this.options.startedEvent
      }
      await this.beginOrResume(request)
      if (this.state.kind !== 'running') {
        throw new LlmError('Codex App Server thread did not enter a running turn', 'INVALID_CONTINUATION')
      }
      const turnId = this.state.turnId
      while (true) {
        const next = await this.options.connection.next()
        if (next.done) throw new LlmError('Codex App Server event stream ended before the turn', 'TRANSPORT')
        const event = next.value
        if (event.kind === 'server-request') {
          if (event.method === 'item/tool/call'
            && event.params.namespace === HARNESS_TOOL_NAMESPACE) {
            this.assertToolRequest(event, turnId)
            this.state = { kind: 'tool', turnId, request: event }
            retained = true
            yield event
            return
          }
          yield await resolveServerRequest(this.options.connection, event)
          continue
        }
        if (event.kind === 'notification' && event.method === 'turn/completed') {
          const completed = object(event.params.turn, 'turn/completed turn')
          if (completed.id === turnId) {
            this.state = { kind: 'idle' }
            retained = true
            yield event
            return
          }
        }
        yield event
      }
    } catch (error: unknown) {
      primary = operationFailure(error, timedOut, request.signal)
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onAbort)
      this.active = false
      if (!retained) {
        try {
          await this.dispose()
        } catch (error: unknown) {
          if (primary === undefined) throw error
          primary = combinedFailure(primary, error)
        }
      }
    }
    if (primary !== undefined) throw primary
  }

  private async beginOrResume(request: CodexAppServerTurnRequest): Promise<void> {
    if (this.state.kind === 'idle') {
      if (request.toolResult !== undefined) {
        throw new LlmError('an idle Codex thread cannot accept a tool result', 'INVALID_CONTINUATION')
      }
      const injectedItems = (request.injectedItems ?? []).map((item, index) => (
        jsonValue(item, `injectedItems[${index}]`)
      ))
      const input = (request.input ?? []).map((item, index) => jsonValue(item, `input[${index}]`))
      if (injectedItems.length > 0) {
        await this.options.connection.request('thread/inject_items', {
          threadId: this.threadId,
          items: injectedItems,
        })
      }
      const started = object(await this.options.connection.request('turn/start', {
        threadId: this.threadId,
        input,
        ...(request.reasoningEffort === undefined ? {} : { effort: request.reasoningEffort }),
      }), 'turn/start result')
      const turnId = threadId(started.turn, 'turn/start turn')
      this.state = { kind: 'running', turnId }
      await this.steer(turnId, request.steeringInputs)
      return
    }
    if (this.state.kind !== 'tool') {
      throw new LlmError('Codex App Server thread is not ready for another step', 'INVALID_CONTINUATION')
    }
    if ((request.injectedItems?.length ?? 0) > 0 || (request.input?.length ?? 0) > 0) {
      throw new LlmError('a pending Codex tool callback cannot also inject turn input', 'INVALID_CONTINUATION')
    }
    const result = request.toolResult
    const callId = this.state.request.params.callId
    if (result === undefined || typeof callId !== 'string' || callId !== result.callId) {
      throw new LlmError('Codex tool result does not match the pending callback', 'INVALID_CONTINUATION')
    }
    await this.options.connection.respond(this.state.request.id, {
      contentItems: result.contentItems.map((item, index) => (
        jsonValue(item, `toolResult.contentItems[${index}]`)
      )),
      success: result.success,
    })
    const turnId = this.state.turnId
    this.state = { kind: 'running', turnId }
    await this.steer(turnId, request.steeringInputs)
  }

  private async steer(
    turnId: string,
    groups: readonly (readonly unknown[])[] | undefined,
  ): Promise<void> {
    for (const [groupIndex, group] of (groups ?? []).entries()) {
      await this.options.connection.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: turnId,
        input: group.map((value, index) => (
          jsonValue(value, `steeringInputs[${String(groupIndex)}][${String(index)}]`)
        )),
      })
    }
  }

  private assertToolRequest(event: PendingToolRequest, turnId: string): void {
    if (event.params.turnId !== turnId
      || typeof event.params.callId !== 'string'
      || event.params.callId.length === 0) {
      throw new LlmError('Codex App Server returned an invalid dynamic-tool callback', 'MALFORMED_RESPONSE')
    }
  }

  dispose(): Promise<void> {
    this.state = { kind: 'disposed' }
    return this.options.dispose()
  }
}
