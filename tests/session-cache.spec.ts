import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerEvent,
  CodexAppServerRequest,
  CodexAppServerRunnerPort,
  CodexAppServerThreadPort,
  CodexAppServerThreadRequest,
  CodexAppServerTurnRequest,
  JsonValue,
} from '../src/runner.ts'
import { CodexSessionCache } from '../src/session-cache.ts'
import type { CodexSessionRequest } from '../src/session-cache.ts'

const user = (text: string): JsonValue => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
})

const assistant = (text: string): JsonValue => ({
  type: 'message',
  id: `assistant-${text}`,
  role: 'assistant',
  content: [{ type: 'output_text', text }],
})

class FakeThread implements CodexAppServerThreadPort {
  readonly threadId: string
  readonly requests: CodexAppServerTurnRequest[] = []
  readonly dispose = vi.fn(async () => {})

  constructor(index: number) {
    this.threadId = `thread-${index}`
  }

  stream(request: CodexAppServerTurnRequest): AsyncIterable<CodexAppServerEvent> {
    this.requests.push(request)
    return (async function * () {})()
  }
}

function fixture(overrides: { maxSessions?: number; idleTimeoutMs?: number } = {}) {
  const threads: FakeThread[] = []
  const runner: CodexAppServerRunnerPort = {
    open: vi.fn(async (_request: CodexAppServerThreadRequest) => {
      const thread = new FakeThread(threads.length + 1)
      threads.push(thread)
      return thread
    }),
    stream: vi.fn((_request: CodexAppServerRequest) => (async function * () {})()),
  }
  const cleanupErrors = vi.fn()
  const cache = new CodexSessionCache({
    runner,
    maxSessions: overrides.maxSessions ?? 8,
    idleTimeoutMs: overrides.idleTimeoutMs ?? 600_000,
    onCleanupError: cleanupErrors,
  })
  return { cache, cleanupErrors, runner, threads }
}

function request(
  sessionId: string,
  history: readonly JsonValue[],
  overrides: Partial<CodexSessionRequest> = {},
): CodexSessionRequest {
  return {
    sessionId,
    epoch: { version: 1 },
    thread: {
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      system: 'Harness system',
      dynamicTools: [],
    },
    history,
    toolResults: [],
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CodexSessionCache', () => {
  it('reuses one thread for an exact user-message continuation', async () => {
    const { cache, runner, threads } = fixture()
    const firstUser = user('first')
    const firstAnswer = assistant('answer')
    const first = await cache.begin(request('session-1', [firstUser]))

    expect(threads[0]?.requests[0]).toMatchObject({
      injectedItems: [firstUser],
      input: [],
    })
    first.commit([firstUser, firstAnswer])

    const second = await cache.begin(request('session-1', [firstUser, firstAnswer, user('follow up')]))
    expect(runner.open).toHaveBeenCalledOnce()
    expect(threads[0]?.requests[1]).toMatchObject({
      input: [{ type: 'text', text: 'follow up', text_elements: [] }],
    })
    expect(threads[0]?.requests[1]?.injectedItems).toBeUndefined()
    await second.discard()
  })

  it('resolves the exact pending App Server tool callback on the same thread', async () => {
    const { cache, runner, threads } = fixture()
    const firstUser = user('read it')
    const call: JsonValue = {
      type: 'function_call',
      call_id: 'call-1',
      namespace: 'deepseek_harness',
      name: 'read_file',
      arguments: '{"path":"a.txt"}',
    }
    const output: JsonValue = {
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'contents',
    }
    const first = await cache.begin(request('session-1', [firstUser]))
    first.commit([firstUser, call], 'call-1')

    const second = await cache.begin(request('session-1', [firstUser, call, output], {
      toolResults: [{ callId: 'call-1', output: 'contents', success: true }],
    }))

    expect(runner.open).toHaveBeenCalledOnce()
    expect(threads[0]?.requests[1]).toMatchObject({
      toolResult: { callId: 'call-1', output: 'contents', success: true },
    })
    expect(threads[0]?.requests[1]?.input).toBeUndefined()
    await second.discard()
  })

  it('rebuilds from the complete request after repair or Harness compaction replaces history', async () => {
    const { cache, runner, threads } = fixture()
    const first = await cache.begin(request('session-1', [user('first')]))
    first.commit([user('first'), assistant('first')])

    const rebuilt = await cache.begin(request('session-1', [user('repaired')]))

    expect(runner.open).toHaveBeenCalledTimes(2)
    expect(threads[0]?.dispose).toHaveBeenCalledOnce()
    expect(threads[1]?.requests[0]).toMatchObject({
      injectedItems: [user('repaired')],
      input: [],
    })
    await rebuilt.discard()
  })

  it('rebuilds when the prompt and tool epoch changes', async () => {
    const { cache, runner, threads } = fixture()
    const firstUser = user('first')
    const firstAnswer = assistant('answer')
    const first = await cache.begin(request('session-1', [firstUser]))
    first.commit([firstUser, firstAnswer])

    const rebuilt = await cache.begin(request('session-1', [firstUser, firstAnswer, user('next')], {
      epoch: { version: 2 },
    }))

    expect(runner.open).toHaveBeenCalledTimes(2)
    expect(threads[0]?.dispose).toHaveBeenCalledOnce()
    await rebuilt.discard()
  })

  it('rejects a second writer while the session step is active', async () => {
    const { cache, runner } = fixture()
    const active = await cache.begin(request('session-1', [user('first')]))

    await expect(cache.begin(request('session-1', [user('second')]))).rejects.toMatchObject({
      code: 'INVALID_CONTINUATION',
    })
    expect(runner.open).toHaveBeenCalledOnce()
    await active.discard()
  })

  it('keeps forked Harness session identities on separate threads', async () => {
    const { cache, runner } = fixture()
    const original = await cache.begin(request('session-original', [user('first')]))
    original.commit([user('first'), assistant('answer')])

    const fork = await cache.begin(request('session-fork', [user('first'), assistant('answer'), user('fork')]))

    expect(runner.open).toHaveBeenCalledTimes(2)
    await fork.discard()
    await cache.dispose()
  })

  it('expires an idle lease and disposes its process', async () => {
    vi.useFakeTimers()
    const { cache, threads } = fixture({ idleTimeoutMs: 100 })
    const first = await cache.begin(request('session-1', [user('first')]))
    first.commit([user('first'), assistant('answer')])

    await vi.advanceTimersByTimeAsync(100)

    expect(threads[0]?.dispose).toHaveBeenCalledOnce()
    await cache.dispose()
  })

  it('evicts the least-recently-used idle lease at capacity', async () => {
    const { cache, threads } = fixture({ maxSessions: 1 })
    const first = await cache.begin(request('session-1', [user('first')]))
    first.commit([user('first'), assistant('answer')])

    const second = await cache.begin(request('session-2', [user('second')]))

    expect(threads[0]?.dispose).toHaveBeenCalledOnce()
    expect(threads).toHaveLength(2)
    await second.discard()
  })

  it('disposes a named session and all remaining leases at shutdown', async () => {
    const { cache, threads } = fixture()
    const first = await cache.begin(request('session-1', [user('first')]))
    first.commit([user('first'), assistant('answer')])
    await cache.disposeSession('session-1')
    expect(threads[0]?.dispose).toHaveBeenCalledOnce()

    const second = await cache.begin(request('session-2', [user('second')]))
    second.commit([user('second'), assistant('answer')])
    await cache.dispose()
    expect(threads[1]?.dispose).toHaveBeenCalledOnce()
    await expect(cache.begin(request('session-3', [user('third')]))).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
