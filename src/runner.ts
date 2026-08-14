/** Managed JSON-RPC transport for the pinned Codex App Server. */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { once } from 'node:events'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { SAFE_MODEL_ID, SAFE_REASONING_EFFORT } from './identifiers.ts'

export const CODEX_APP_SERVER_VERSION = '0.147.0'

const WORKDIR_PREFIX = 'dsh-codex-app-server-'
const TIMEOUT_REASON = Symbol('codex-app-server-timeout')
const CONSUMER_REASON = Symbol('codex-app-server-consumer-stop')
const CODEX_DISABLED_FEATURES = [
  'apps',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'hooks',
  'image_generation',
  'in_app_browser',
  'mcp_2026_07_28',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'remote_plugin',
  'request_permissions_tool',
  'shell_tool',
  'skill_search',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'unified_exec',
  'view_image',
] as const

/** Lossless JSON value accepted by the App Server protocol. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface JsonObject {
  readonly [key: string]: unknown
}

type JsonRpcId = number | string

/** Complete input for one stateless App Server turn. */
export interface CodexAppServerRequest {
  readonly model: string
  readonly modelProvider: string
  readonly reasoningEffort?: string
  readonly system: string
  readonly history: readonly JsonValue[]
  readonly dynamicTools: readonly JsonValue[]
  readonly signal?: AbortSignal
}

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

/** Deployment values for one App Server process. */
export interface CodexAppServerRunnerOptions {
  readonly timeoutMs: number
  readonly disposeGraceMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly env: Readonly<Record<string, string>>
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

/** Testable streaming process contract used by the adapter. */
export interface CodexAppServerRunnerPort {
  stream(request: CodexAppServerRequest): AsyncIterable<CodexAppServerEvent>
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

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  return value as JsonObject
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

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, `${label}.${key}`)]))
  }
  throw new LlmError(`Codex App Server returned non-JSON ${label}`, 'MALFORMED_RESPONSE')
}

class JsonRpcConnection {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly events = new AsyncQueue<CodexAppServerEvent>()
  private nextId = 1
  private buffer = ''
  private stdoutBytes = 0
  private stopped = false

  constructor(
    private readonly input: Writable,
    private readonly output: Readable,
    private readonly maxStdoutBytes: number,
  ) {
    output.setEncoding('utf8')
    output.on('data', this.onData)
    output.once('end', this.onEnd)
    output.once('error', this.onError)
    input.once('error', this.onError)
  }

  private readonly onData = (chunk: string): void => {
    if (this.stopped) return
    this.stdoutBytes += Buffer.byteLength(chunk)
    if (this.stdoutBytes > this.maxStdoutBytes) {
      this.fail(new LlmError('Codex App Server stdout exceeded its configured limit', 'OUTPUT_LIMIT'))
      return
    }
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) break
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
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

  notify(method: string, params: JsonObject): Promise<void> {
    return this.send({ method, params })
  }

  respond(id: JsonRpcId, result: JsonValue): Promise<void> {
    return this.send({ id, result })
  }

  respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    return this.send({ id, error: { code, message } })
  }

  next(): Promise<IteratorResult<CodexAppServerEvent>> {
    return this.events.next()
  }

  fail(error: Error): void {
    if (this.stopped) return
    this.stopped = true
    this.detach()
    for (const pending of this.pending.values()) pending.waiter.reject(error)
    this.pending.clear()
    this.events.close(error)
  }

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

/** Resolve the pinned official CLI's JavaScript entry without a shell lookup. */
export function codexCliEntry(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js')
}

/** Build the fixed, non-shell App Server argv. */
export function codexAppServerArgv(): string[] {
  const disabled = CODEX_DISABLED_FEATURES.flatMap(feature => ['--disable', feature])
  return [
    process.execPath,
    codexCliEntry(),
    'app-server',
    '--stdio',
    '--strict-config',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    'analytics.enabled=false',
    '-c',
    'web_search="disabled"',
    ...disabled,
  ]
}

async function privateWorkdir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), WORKDIR_PREFIX))
  await chmod(path, 0o700)
  return path
}

async function removePrivateWorkdir(path: string): Promise<void> {
  const base = resolve(tmpdir())
  if (resolve(dirname(path)) !== base || !path.slice(base.length + 1).startsWith(WORKDIR_PREFIX)) {
    throw new Error('refusing to remove an unexpected Codex App Server directory')
  }
  await rm(path, { recursive: true, force: true })
}

function readStderr(child: SubprocessHandle): string {
  const reader = child.collected.stderr
  if (reader === undefined) return ''
  const read = reader.readFrom(0)
  return read.lossy ? `${read.text}\n[stderr capture exceeded its configured limit]` : read.text
}

async function cleanupRun(
  child: SubprocessHandle | undefined,
  connection: JsonRpcConnection | undefined,
  workdir: string,
  graceMs: number,
): Promise<Error[]> {
  const failures: Error[] = []
  connection?.dispose()
  if (child !== undefined) {
    try {
      child.stdin?.end()
      child.terminate()
    } catch (error: unknown) {
      failures.push(thrown(error))
    }
    try {
      const waitMs = Math.min(2_147_483_647, Math.max(1, graceMs * 2))
      if (!await child.waitForExit(AbortSignal.timeout(waitMs))) {
        failures.push(new Error('Codex App Server process tree did not reach quiescence'))
      }
    } catch (error: unknown) {
      failures.push(thrown(error))
    }
    await child.done.catch(() => {})
  }
  try {
    await removePrivateWorkdir(workdir)
  } catch (error: unknown) {
    failures.push(thrown(error))
  }
  return failures
}

function cleanupError(primary: LlmError | undefined, failures: readonly Error[]): LlmError | undefined {
  if (failures.length === 0) return primary
  const detail = failures.map(failure => failure.message).join('; ')
  if (primary === undefined) {
    return new LlmError(`Codex App Server cleanup failed: ${detail}`, 'TRANSPORT', {
      cause: new AggregateError(failures, 'Codex App Server cleanup failed'),
    })
  }
  return new LlmError(`${primary.message}; cleanup also failed: ${detail}`, primary.code, {
    cause: new AggregateError([primary, ...failures], 'Codex App Server request and cleanup failed'),
  })
}

function failureFor(error: unknown, lifetime: AbortSignal, caller: AbortSignal | undefined): LlmError {
  if (lifetime.reason === TIMEOUT_REASON) {
    return new LlmError('Codex App Server request timed out', 'TIMEOUT', { cause: error })
  }
  if (caller?.aborted) return new LlmError('Codex App Server request aborted by caller', 'ABORTED', { cause: error })
  return error instanceof LlmError
    ? error
    : new LlmError('Codex App Server request failed', 'TRANSPORT', { cause: thrown(error) })
}

function validateRequest(request: CodexAppServerRequest): void {
  if (!SAFE_MODEL_ID.test(request.model)) {
    throw new LlmError(`Codex model is not a safe identifier: ${JSON.stringify(request.model)}`, 'INVALID_MODEL')
  }
  if (!SAFE_MODEL_ID.test(request.modelProvider)) {
    throw new LlmError(
      `Codex model provider is not a safe identifier: ${JSON.stringify(request.modelProvider)}`,
      'INVALID_PROVIDER',
    )
  }
  if (request.reasoningEffort !== undefined && !SAFE_REASONING_EFFORT.test(request.reasoningEffort)) {
    throw new LlmError(
      `Codex reasoning effort is not a safe identifier: ${JSON.stringify(request.reasoningEffort)}`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
}

function threadId(value: unknown, label: string): string {
  const candidate = object(value, label)
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new LlmError(`Codex App Server returned invalid ${label}.id`, 'MALFORMED_RESPONSE')
  }
  return candidate.id
}

function instructionSources(value: unknown): JsonValue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new LlmError('Codex App Server returned invalid instructionSources', 'MALFORMED_RESPONSE')
  }
  return value.map((source, index) => jsonValue(source, `instructionSources[${index}]`))
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

/** One-process-per-request App Server runner with bounded framing and tree-scoped teardown. */
export class CodexAppServerRunner implements CodexAppServerRunnerPort {
  constructor(private readonly options: CodexAppServerRunnerOptions) {}

  async * stream(request: CodexAppServerRequest): AsyncIterable<CodexAppServerEvent> {
    validateRequest(request)
    let workdir: string
    try {
      workdir = await privateWorkdir()
    } catch (error: unknown) {
      throw new LlmError('Codex App Server private directory setup failed', 'TRANSPORT', { cause: thrown(error) })
    }
    const lifetime = new AbortController()
    const signal = request.signal === undefined
      ? lifetime.signal
      : AbortSignal.any([request.signal, lifetime.signal])
    const timeout = setTimeout(() => { lifetime.abort(TIMEOUT_REASON) }, this.options.timeoutMs)
    let child: SubprocessHandle | undefined
    let connection: JsonRpcConnection | undefined
    let failure: LlmError | undefined
    try {
      if (signal.aborted) throw signal.reason
      child = this.options.spawn({
        argv: codexAppServerArgv(),
        cwd: workdir,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: this.options.maxStderrBytes },
        },
        graceMs: this.options.disposeGraceMs,
        signal,
        env: {
          ...this.options.env,
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'deepseek-harness',
        },
      })
      if (child.stdin === undefined || child.stdout === undefined) {
        throw new LlmError('Codex App Server subprocess did not expose protocol pipes', 'TRANSPORT')
      }
      connection = new JsonRpcConnection(child.stdin, child.stdout, this.options.maxStdoutBytes)
      const activeConnection = connection
      void child.done.then((outcome: SubprocessOutcome) => {
        const stderr = readStderr(child!)
        const detail = stderr.trim().length === 0 ? '' : `: ${stderr.trim()}`
        activeConnection.fail(new LlmError(
          `Codex App Server exited with ${String(outcome.exitCode)}/${String(outcome.signal)}${detail}`,
          'TRANSPORT',
        ))
      }, (error: unknown) => {
        activeConnection.fail(new LlmError('Codex App Server process failed to start', 'TRANSPORT', {
          cause: thrown(error),
        }))
      })
      const onAbort = (): void => {
        activeConnection.fail(new LlmError('Codex App Server request was cancelled', 'ABORTED', {
          cause: signal.reason,
        }))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const initialized = object(await activeConnection.request('initialize', {
          clientInfo: {
            name: 'deepseek-harness',
            title: 'DeepSeek Harness',
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        }), 'initialize result')
        if (typeof initialized.userAgent !== 'string'
          || !initialized.userAgent.includes(CODEX_APP_SERVER_VERSION)) {
          throw new LlmError(
            `Codex App Server version mismatch: ${JSON.stringify(initialized.userAgent)}`,
            'PROTOCOL_VERSION',
          )
        }
        await activeConnection.notify('initialized', {})
        const started = object(await activeConnection.request('thread/start', {
          model: request.model,
          modelProvider: request.modelProvider,
          cwd: workdir,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          baseInstructions: request.system,
          developerInstructions: '',
          personality: 'none',
          multiAgentMode: null,
          ephemeral: true,
          historyMode: 'legacy',
          environments: [],
          runtimeWorkspaceRoots: [],
          selectedCapabilityRoots: [],
          dynamicTools: request.dynamicTools,
          experimentalRawEvents: true,
          serviceName: 'deepseek-harness',
        }), 'thread/start result')
        const id = threadId(started.thread, 'thread/start thread')
        yield {
          kind: 'thread-started',
          threadId: id,
          userAgent: initialized.userAgent,
          instructionSources: instructionSources(started.instructionSources),
        }
        if (request.history.length > 0) {
          await activeConnection.request('thread/inject_items', {
            threadId: id,
            items: request.history,
          })
        }
        const turnStarted = object(await activeConnection.request('turn/start', {
          threadId: id,
          input: [],
          ...(request.reasoningEffort === undefined ? {} : { effort: request.reasoningEffort }),
        }), 'turn/start result')
        const turn = threadId(turnStarted.turn, 'turn/start turn')
        let terminal = false
        while (!terminal) {
          const next = await activeConnection.next()
          if (next.done) throw new LlmError('Codex App Server event stream ended before the turn', 'TRANSPORT')
          const event = next.value
          if (event.kind === 'server-request') {
            if (event.method === 'item/tool/call') {
              terminal = true
              yield event
            } else {
              yield await resolveServerRequest(activeConnection, event)
            }
            continue
          }
          yield event
          if (event.kind === 'notification' && event.method === 'turn/completed') {
            const paramsTurn = object(event.params.turn, 'turn/completed turn')
            if (paramsTurn.id === turn) terminal = true
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    } catch (error: unknown) {
      failure = failureFor(error, lifetime.signal, request.signal)
    } finally {
      clearTimeout(timeout)
      if (!lifetime.signal.aborted) lifetime.abort(CONSUMER_REASON)
      failure = cleanupError(
        failure,
        await cleanupRun(child, connection, workdir, this.options.disposeGraceMs),
      )
      if (failure !== undefined) throw failure
    }
  }
}
