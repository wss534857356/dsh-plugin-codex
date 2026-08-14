/** Bounded bidirectional newline-delimited JSON-RPC transport for App Server. */

import { once } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** Lossless JSON value accepted by the App Server protocol. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Decoded JSON object at the App Server boundary. */
export interface JsonObject {
  readonly [key: string]: unknown
}

/** Request identifier accepted by JSON-RPC. */
export type JsonRpcId = number | string

/** One decoded App Server event retained at the provider boundary. */
export type CodexAppServerEvent =
  | {
      readonly kind: 'thread-started'
      readonly threadId: string
      readonly userAgent: string
      readonly instructionSources: readonly JsonValue[]
    }
  | {
      readonly kind: 'notification'
      readonly method: string
      readonly params: JsonObject
    }
  | {
      readonly kind: 'server-request'
      readonly id: JsonRpcId
      readonly method: string
      readonly params: JsonObject
      readonly resolution: 'answered' | 'declined' | 'rejected'
    }

interface PendingRequest {
  readonly method: string
  readonly waiter: ReturnType<typeof Promise.withResolvers<unknown>>
}

interface QueuedWaiter<T> {
  readonly resolve: (result: IteratorResult<T>) => void
  readonly reject: (error: unknown) => void
}

class AsyncQueue<T> {
  private readonly values: T[] = []
  private readonly waiters: QueuedWaiter<T>[] = []
  private closed = false
  private failure: Error | undefined

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter.resolve({ done: false, value })
  }

  close(failure?: Error): void {
    if (this.closed) return
    this.closed = true
    this.failure = failure
    for (const waiter of this.waiters.splice(0)) {
      if (failure === undefined) waiter.resolve({ done: true, value: undefined })
      else waiter.reject(failure)
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    const waiter = Promise.withResolvers<IteratorResult<T>>()
    this.waiters.push(waiter)
    return waiter.promise
  }
}

/** Require a decoded value to be a JSON object. */
export function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  return value as JsonObject
}

/** Copy and validate one decoded lossless JSON value. */
export function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, `${label}.${key}`)]))
  }
  throw new LlmError(`Codex App Server returned non-JSON ${label}`, 'MALFORMED_RESPONSE')
}

function rpcId(value: unknown): JsonRpcId | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function rpcKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** One connected App Server JSON-RPC peer. */
export class JsonRpcConnection {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly events = new AsyncQueue<CodexAppServerEvent>()
  private nextId = 1
  private buffer = ''
  private stopped = false

  /**
   * @param input - writable App Server stdin.
   * @param output - readable App Server stdout.
   * @param maxJsonRpcLineBytes - maximum UTF-8 bytes retained for one frame.
   */
  constructor(
    private readonly input: Writable,
    private readonly output: Readable,
    private readonly maxJsonRpcLineBytes: number,
  ) {
    output.setEncoding('utf8')
    output.on('data', this.onData)
    output.once('end', this.onEnd)
    output.once('error', this.onError)
    input.once('error', this.onError)
  }

  private readonly onData = (chunk: string): void => {
    if (this.stopped) return
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) {
        if (Buffer.byteLength(this.buffer) > this.maxJsonRpcLineBytes) {
          this.fail(new LlmError(
            'Codex App Server JSON-RPC line exceeded its configured limit',
            'OUTPUT_LIMIT',
          ))
        }
        return
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
      if (Buffer.byteLength(line) > this.maxJsonRpcLineBytes) {
        this.fail(new LlmError(
          'Codex App Server JSON-RPC line exceeded its configured limit',
          'OUTPUT_LIMIT',
        ))
        return
      }
      try {
        this.receive(JSON.parse(line))
      } catch (error: unknown) {
        this.fail(error instanceof LlmError
          ? error
          : new LlmError('Codex App Server emitted malformed JSON-RPC', 'MALFORMED_RESPONSE', {
              cause: thrown(error),
            }))
        return
      }
    }
  }

  private readonly onEnd = (): void => {
    if (this.stopped) return
    if (this.buffer.trim().length !== 0) {
      this.fail(new LlmError('Codex App Server stdout ended with an incomplete JSON-RPC line', 'MALFORMED_RESPONSE'))
      return
    }
    this.fail(new LlmError('Codex App Server closed its protocol stream', 'TRANSPORT'))
  }

  private readonly onError = (error: Error): void => {
    this.fail(new LlmError('Codex App Server protocol stream failed', 'TRANSPORT', { cause: error }))
  }

  private receive(value: unknown): void {
    const envelope = object(value, 'JSON-RPC envelope')
    const id = rpcId(envelope.id)
    if (typeof envelope.method === 'string') {
      const params = object(envelope.params ?? {}, `${envelope.method} params`)
      if (id === undefined) {
        this.events.push({ kind: 'notification', method: envelope.method, params })
      } else {
        this.events.push({
          kind: 'server-request',
          id,
          method: envelope.method,
          params,
          resolution: 'rejected',
        })
      }
      return
    }
    if (id === undefined) throw new LlmError('Codex App Server response has no id', 'MALFORMED_RESPONSE')
    const pending = this.pending.get(rpcKey(id))
    if (pending === undefined) throw new LlmError('Codex App Server returned an unknown response id', 'MALFORMED_RESPONSE')
    this.pending.delete(rpcKey(id))
    if (envelope.error !== undefined) {
      pending.waiter.reject(new LlmError(
        `Codex App Server ${pending.method} failed: ${JSON.stringify(envelope.error)}`,
        'CODEX_PROTOCOL',
      ))
    } else {
      pending.waiter.resolve(envelope.result)
    }
  }

  private async send(envelope: JsonObject): Promise<void> {
    if (this.stopped) throw new LlmError('Codex App Server connection is closed', 'TRANSPORT')
    const line = `${JSON.stringify(envelope)}\n`
    if (this.input.write(line)) return
    await once(this.input, 'drain')
  }

  /** Send one client request and resolve its correlated response. */
  async request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++
    const waiter = Promise.withResolvers<unknown>()
    this.pending.set(rpcKey(id), { method, waiter })
    try {
      await this.send({ method, id, params })
    } catch (error: unknown) {
      this.pending.delete(rpcKey(id))
      waiter.reject(error)
    }
    return waiter.promise
  }

  /** Send one client notification. */
  notify(method: string, params: JsonObject): Promise<void> {
    return this.send({ method, params })
  }

  /** Resolve one App Server request. */
  respond(id: JsonRpcId, result: JsonValue): Promise<void> {
    return this.send({ id, result })
  }

  /** Reject one App Server request. */
  respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    return this.send({ id, error: { code, message } })
  }

  /** Read the next notification or server request. */
  next(): Promise<IteratorResult<CodexAppServerEvent>> {
    return this.events.next()
  }

  /** Fail every waiter and detach the stream listeners. */
  fail(error: Error): void {
    if (this.stopped) return
    this.stopped = true
    this.detach()
    for (const pending of this.pending.values()) pending.waiter.reject(error)
    this.pending.clear()
    this.events.close(error)
  }

  /** Close every waiter without manufacturing a transport failure. */
  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    this.detach()
    const error = new LlmError('Codex App Server connection disposed', 'ABORTED')
    for (const pending of this.pending.values()) pending.waiter.reject(error)
    this.pending.clear()
    this.events.close()
  }

  private detach(): void {
    this.output.off('data', this.onData)
    this.output.off('end', this.onEnd)
    this.output.off('error', this.onError)
    this.input.off('error', this.onError)
  }
}
