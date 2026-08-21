import { PassThrough } from 'node:stream'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  CODEX_APP_SERVER_VERSION,
  CodexAppServerRunner,
  codexAppServerArgv,
  codexCliEntry,
} from '../src/runner.ts'
import type {
  CodexAppServerEvent,
  CodexAppServerRequest,
  CodexAppServerRunnerOptions,
  CodexAppServerThreadPort,
  CodexAppServerTurnRequest,
} from '../src/runner.ts'

interface JsonObject {
  readonly [key: string]: unknown
}

type Script = (
  message: JsonObject,
  send: (message: JsonObject) => void,
  sendRaw: (text: string) => void,
) => void

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object')
  return value as JsonObject
}

function scriptedHandle(script: Script): SubprocessHandle {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const outcome = Promise.withResolvers<SubprocessOutcome>()
  let input = ''
  let stopped = false
  const send = (message: JsonObject): void => {
    stdout.write(`${JSON.stringify(message)}\n`)
  }
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    input += chunk
    while (true) {
      const newline = input.indexOf('\n')
      if (newline === -1) return
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      if (line.trim().length !== 0) script(object(JSON.parse(line)), send, text => { stdout.write(text) })
    }
  })
  const terminate = vi.fn(() => {
    if (stopped) return
    stopped = true
    stdout.end()
    outcome.resolve({ exitCode: 0, signal: null })
  })
  return {
    pid: 123,
    stdin,
    stdout,
    stderr: undefined,
    collected: {
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: outcome.promise,
    terminate,
    waitForExit: vi.fn(async () => true),
  }
}

function standardScript(afterTurn: (send: (message: JsonObject) => void) => void): Script {
  return (message, send) => {
    if (message.method === 'initialize') {
      send({ id: message.id, result: { userAgent: `codex_app_server/${CODEX_APP_SERVER_VERSION}` } })
    } else if (message.method === 'thread/start') {
      send({
        id: message.id,
        result: {
          thread: { id: 'thread-1' },
          instructionSources: [{ path: 'C:/Users/test/.codex/AGENTS.md' }],
        },
      })
    } else if (message.method === 'thread/inject_items') {
      send({ id: message.id, result: {} })
    } else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-1' } } })
      afterTurn(send)
    }
  }
}

function request(overrides: Partial<CodexAppServerRequest> = {}): CodexAppServerRequest {
  return {
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    system: 'Harness system',
    history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    dynamicTools: [],
    ...overrides,
  }
}

function runner(
  script: Script,
  overrides: Partial<CodexAppServerRunnerOptions> = {},
): { runner: CodexAppServerRunner; child: SubprocessHandle; spec: () => SubprocessSpawnSpec } {
  const child = scriptedHandle(script)
  let spawned: SubprocessSpawnSpec | undefined
  return {
    child,
    spec: () => {
      if (spawned === undefined) throw new Error('process was not spawned')
      return spawned
    },
    runner: new CodexAppServerRunner({
      timeoutMs: 1_000,
      disposeGraceMs: 25,
      maxJsonRpcLineBytes: 100_000,
      maxStderrBytes: 1_000,
      env: { CODEX_HOME: 'configured-home' },
      spawn: (candidate) => {
        spawned = candidate
        expect(existsSync(candidate.cwd)).toBe(true)
        return child
      },
      ...overrides,
    }),
  }
}

async function collect(instance: CodexAppServerRunner, input: CodexAppServerRequest): Promise<CodexAppServerEvent[]> {
  const events: CodexAppServerEvent[] = []
  for await (const event of instance.stream(input)) events.push(event)
  return events
}

async function collectTurn(
  thread: CodexAppServerThreadPort,
  input: CodexAppServerTurnRequest,
): Promise<CodexAppServerEvent[]> {
  const events: CodexAppServerEvent[] = []
  for await (const event of thread.stream(input)) events.push(event)
  return events
}

describe('Codex App Server runner', () => {
  it('uses the pinned CLI entry and fixed non-shell policy', () => {
    expect(existsSync(codexCliEntry())).toBe(true)
    const argv = codexAppServerArgv()
    expect(argv.slice(0, 3)).toEqual([process.execPath, codexCliEntry(), 'app-server'])
    expect(argv).toContain('--stdio')
    expect(argv).toContain('--strict-config')
    expect(argv).toContain('check_for_update_on_startup=false')
    expect(argv).toContain('analytics.enabled=false')
    expect(argv).toContain('web_search="disabled"')
    expect(argv).toContain(`model_auto_compact_token_limit=${String(Number.MAX_SAFE_INTEGER)}`)
    const enabledFeatures = argv.flatMap((argument, index) => argument === '--enable' ? [argv[index + 1]] : [])
    const disabledFeatures = argv.flatMap((argument, index) => argument === '--disable' ? [argv[index + 1]] : [])
    expect(enabledFeatures).toEqual(expect.arrayContaining(['image_generation', 'view_image']))
    expect(disabledFeatures).not.toContain('image_generation')
    expect(disabledFeatures).not.toContain('view_image')
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')

    const searchArgv = codexAppServerArgv('live')
    expect(searchArgv).toContain('web_search="live"')
    const searchDisabledFeatures = searchArgv.flatMap(
      (argument, index) => argument === '--disable' ? [searchArgv[index + 1]] : [],
    )
    expect(searchDisabledFeatures).not.toContain('standalone_web_search')

    const noImageArgv = codexAppServerArgv('disabled', false)
    const noImageEnabledFeatures = noImageArgv.flatMap(
      (argument, index) => argument === '--enable' ? [noImageArgv[index + 1]] : [],
    )
    const noImageDisabledFeatures = noImageArgv.flatMap(
      (argument, index) => argument === '--disable' ? [noImageArgv[index + 1]] : [],
    )
    expect(noImageEnabledFeatures).not.toContain('image_generation')
    expect(noImageEnabledFeatures).toContain('view_image')
    expect(noImageDisabledFeatures).toContain('image_generation')
  })

  it('starts an ephemeral thread, injects history, streams events, and reaches quiescence', async () => {
    const messages: JsonObject[] = []
    const setup = runner((message, send, sendRaw) => {
      messages.push(message)
      standardScript((write) => {
        write({ method: 'item/agentMessage/delta', params: {
          threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'hello',
        } })
        write({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', error: null },
        } })
      })(message, send, sendRaw)
    })

    const events = await collect(setup.runner, request({ reasoningEffort: 'high' }))
    expect(events[0]).toMatchObject({
      kind: 'thread-started',
      threadId: 'thread-1',
      instructionSources: [{ path: 'C:/Users/test/.codex/AGENTS.md' }],
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'notification', method: 'item/agentMessage/delta' }),
      expect.objectContaining({ kind: 'notification', method: 'turn/completed' }),
    ]))
    expect(messages.find(message => message.method === 'initialize')).toMatchObject({
      params: { clientInfo: { name: 'deepseek-harness', version: '0.1.19' } },
    })
    expect(messages.find(message => message.method === 'thread/start')).toMatchObject({
      params: {
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: 'Harness system',
        developerInstructions: '',
        dynamicTools: [],
        ephemeral: true,
        experimentalRawEvents: true,
      },
    })
    expect(messages.find(message => message.method === 'thread/inject_items')).toMatchObject({
      params: { threadId: 'thread-1', items: request().history },
    })
    expect(messages.find(message => message.method === 'turn/start')).toMatchObject({
      params: { threadId: 'thread-1', input: [], effort: 'high' },
    })
    expect(setup.spec()).toMatchObject({
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 1_000 } },
      env: {
        CODEX_HOME: 'configured-home',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'deepseek-harness',
      },
    })
    expect(existsSync(setup.spec().cwd)).toBe(false)
    expect(setup.child.terminate).toHaveBeenCalledOnce()
    expect(setup.child.waitForExit).toHaveBeenCalledOnce()
  })

  it('starts a live-search process only for an explicit search request', async () => {
    const setup = runner(standardScript((write) => {
      write({ method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null },
      } })
    }))

    await collect(setup.runner, request({ webSearch: 'live' }))

    expect(setup.spec().argv).toContain('web_search="live"')
    expect(setup.spec().argv).not.toEqual(expect.arrayContaining(['--disable', 'standalone_web_search']))
  })

  it('applies the image-generation policy to each new process', async () => {
    const setup = runner(standardScript((write) => {
      write({ method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null },
      } })
    }))

    await collect(setup.runner, request({ imageGenerationEnabled: false }))

    expect(setup.spec().argv).toEqual(expect.arrayContaining(['--disable', 'image_generation']))
    const enabledFeatures = setup.spec().argv.flatMap(
      (argument, index) => argument === '--enable' ? [setup.spec().argv[index + 1]] : [],
    )
    expect(enabledFeatures).not.toContain('image_generation')
  })

  it('hands a dynamic tool request back without sending a provider-side result', async () => {
    const messages: JsonObject[] = []
    const setup = runner((message, send, sendRaw) => {
      messages.push(message)
      standardScript((write) => {
        write({
          id: 'server-call-1',
          method: 'item/tool/call',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            callId: 'call-1',
            namespace: 'deepseek_harness',
            tool: 'read_file',
            arguments: { path: 'a.txt' },
          },
        })
      })(message, send, sendRaw)
    })

    await expect(collect(setup.runner, request())).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'server-request',
        id: 'server-call-1',
        method: 'item/tool/call',
      }),
    ]))
    expect(messages.some(message => message.id === 'server-call-1')).toBe(false)
    expect(setup.child.terminate).toHaveBeenCalledOnce()
  })

  it('reports and rejects an unnamespaced tool request without handing it to Harness', async () => {
    const messages: JsonObject[] = []
    const setup = runner((message, send, sendRaw) => {
      messages.push(message)
      standardScript((write) => {
        write({
          id: 'native-skill-1',
          method: 'item/tool/call',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            callId: 'native-skill-1',
            namespace: null,
            tool: 'skill',
            arguments: { name: 'imagegen' },
          },
        })
      })(message, send, sendRaw)
      if (message.id === 'native-skill-1') {
        expect(message.error).toMatchObject({
          code: -32_001,
          message: 'DeepSeek Harness cannot answer item/tool/call',
        })
        send({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', error: null },
        } })
      }
    })

    const events = await collect(setup.runner, request())
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'server-request',
        id: 'native-skill-1',
        method: 'item/tool/call',
        resolution: 'rejected',
      }),
      expect.objectContaining({ kind: 'notification', method: 'turn/completed' }),
    ]))
    expect(messages.some(message => message.id === 'native-skill-1' && message.result !== undefined)).toBe(false)
  })

  it('keeps one ephemeral process alive across serialized turns', async () => {
    const messages: JsonObject[] = []
    let nextTurn = 0
    const setup = runner((message, send, sendRaw) => {
      messages.push(message)
      if (message.method === 'turn/start') {
        nextTurn += 1
        const id = `turn-${String(nextTurn)}`
        send({ id: message.id, result: { turn: { id } } })
        send({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: { id, status: 'completed', error: null },
        } })
      } else {
        standardScript(() => {})(message, send, sendRaw)
      }
    })

    const thread = await setup.runner.open(request())
    const first = await collectTurn(thread, {
      injectedItems: request().history,
      input: [],
    })
    expect(first[0]).toMatchObject({ kind: 'thread-started', threadId: 'thread-1' })
    expect(setup.child.terminate).not.toHaveBeenCalled()
    expect(existsSync(setup.spec().cwd)).toBe(true)

    const second = await collectTurn(thread, {
      input: [{ type: 'text', text: 'follow up', text_elements: [] }],
    })
    expect(second.some(event => event.kind === 'thread-started')).toBe(false)
    expect(messages.filter(message => message.method === 'thread/start')).toHaveLength(1)
    expect(messages.filter(message => message.method === 'turn/start')).toHaveLength(2)
    expect(messages.filter(message => message.method === 'turn/start')[1]).toMatchObject({
      params: { input: [{ type: 'text', text: 'follow up', text_elements: [] }] },
    })

    await thread.dispose()
    expect(existsSync(setup.spec().cwd)).toBe(false)
    expect(setup.child.terminate).toHaveBeenCalledOnce()
    expect(setup.child.waitForExit).toHaveBeenCalledOnce()
  })

  it('steers additional user messages after starting a warm turn', async () => {
    const messages: JsonObject[] = []
    const setup = runner((message, send, sendRaw) => {
      messages.push(message)
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } })
      } else if (message.method === 'turn/steer') {
        send({ id: message.id, result: {} })
        send({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', error: null },
        } })
      } else {
        standardScript(() => {})(message, send, sendRaw)
      }
    })

    const thread = await setup.runner.open(request())
    await expect(collectTurn(thread, {
      input: [{ type: 'text', text: 'first', text_elements: [] }],
      steeringInputs: [[{ type: 'text', text: 'second', text_elements: [] }]],
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'notification', method: 'turn/completed' }),
    ]))
    expect(messages.find(message => message.method === 'turn/steer')).toMatchObject({
      params: {
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'second', text_elements: [] }],
      },
    })
    await thread.dispose()
  })

  it('holds a dynamic-tool callback across Harness steps and resumes the same turn', async () => {
    const messages: JsonObject[] = []
    const setup = runner((message, send, sendRaw) => {
      messages.push(message)
      standardScript((write) => {
        write({
          id: 'server-call-1',
          method: 'item/tool/call',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            callId: 'call-1',
            namespace: 'deepseek_harness',
            tool: 'read_file',
            arguments: { path: 'a.txt' },
          },
        })
      })(message, send, sendRaw)
      if (message.id === 'server-call-1') {
        expect(message.result).toEqual({
          contentItems: [
            { type: 'inputText', text: 'file text' },
            { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
          ],
          success: true,
        })
        send({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', error: null },
        } })
      }
    })

    const thread = await setup.runner.open(request())
    const first = await collectTurn(thread, { injectedItems: request().history })
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'server-request', id: 'server-call-1' }),
    ]))
    expect(setup.child.terminate).not.toHaveBeenCalled()

    await expect(collectTurn(thread, {
      toolResult: {
        callId: 'call-1',
        contentItems: [
          { type: 'inputText', text: 'file text' },
          { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
        ],
        success: true,
      },
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'notification', method: 'turn/completed' }),
    ]))
    expect(messages.filter(message => message.method === 'turn/start')).toHaveLength(1)
    await thread.dispose()
  })

  it('responds to a dynamic-tool callback before steering queued inbox messages', async () => {
    const messages: JsonObject[] = []
    let steers = 0
    const setup = runner((message, send, sendRaw) => {
      messages.push(message)
      standardScript((write) => {
        write({
          id: 'server-call-steer',
          method: 'item/tool/call',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            callId: 'call-steer',
            namespace: 'deepseek_harness',
            tool: 'subagent',
            arguments: {},
          },
        })
      })(message, send, sendRaw)
      if (message.method === 'turn/steer') {
        steers += 1
        send({ id: message.id, result: {} })
        if (steers === 2) {
          send({ method: 'turn/completed', params: {
            threadId: 'thread-1',
            turn: { id: 'turn-1', status: 'completed', error: null },
          } })
        }
      }
    })

    const thread = await setup.runner.open(request())
    await collectTurn(thread, {})
    await expect(collectTurn(thread, {
      toolResult: {
        callId: 'call-steer',
        contentItems: [{ type: 'inputText', text: 'started' }],
        success: true,
      },
      steeringInputs: [
        [{ type: 'text', text: 'report', text_elements: [] }],
        [{ type: 'text', text: 'settled', text_elements: [] }],
      ],
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'notification', method: 'turn/completed' }),
    ]))

    const responseIndex = messages.findIndex(message => message.id === 'server-call-steer')
    const steerIndexes = messages.flatMap((message, index) => message.method === 'turn/steer' ? [index] : [])
    expect(responseIndex).toBeGreaterThan(-1)
    expect(steerIndexes).toHaveLength(2)
    expect(steerIndexes.every(index => index > responseIndex)).toBe(true)
    expect(steerIndexes.map(index => messages[index]?.params)).toEqual([
      expect.objectContaining({ expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'report', text_elements: [] }] }),
      expect.objectContaining({ expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'settled', text_elements: [] }] }),
    ])
    await thread.dispose()
  })

  it('disposes a thread after a mismatched dynamic-tool result', async () => {
    const setup = runner(standardScript((send) => {
      send({
        id: 'server-call-1',
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-1',
          namespace: 'deepseek_harness',
          tool: 'read_file',
          arguments: { path: 'a.txt' },
        },
      })
    }))
    const thread = await setup.runner.open(request())
    await collectTurn(thread, {})

    await expect(collectTurn(thread, {
      toolResult: { callId: 'wrong-call', contentItems: [{ type: 'inputText', text: 'file text' }], success: true },
    })).rejects.toMatchObject({ code: 'INVALID_CONTINUATION' })
    expect(setup.child.terminate).toHaveBeenCalledOnce()
  })

  it('rejects a concurrent continuation while its owner still consumes the thread', async () => {
    const setup = runner(standardScript(() => {}))
    const thread = await setup.runner.open(request())
    const first = thread.stream({})[Symbol.asyncIterator]()
    await expect(first.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'thread-started', threadId: 'thread-1' },
    })
    await expect(collectTurn(thread, {})).rejects.toMatchObject({ code: 'INVALID_CONTINUATION' })
    await first.return?.()
    expect(setup.child.terminate).toHaveBeenCalledOnce()
  })

  it('reports and declines a Codex-native approval without failing the turn', async () => {
    const setup = runner((message, send, sendRaw) => {
      standardScript((write) => {
        write({
          id: 'approval-1',
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1' },
        })
      })(message, send, sendRaw)
      if (message.id === 'approval-1') {
        expect(message.result).toEqual({ decision: 'decline' })
        send({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', error: null },
        } })
      }
    })

    const events = await collect(setup.runner, request())
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'server-request',
        method: 'item/commandExecution/requestApproval',
        resolution: 'declined',
      }),
      expect.objectContaining({ kind: 'notification', method: 'turn/completed' }),
    ]))
  })

  it('classifies deadline and caller cancellation separately', async () => {
    const opening = runner(() => {}, { timeoutMs: 5 })
    await expect(opening.runner.open(request())).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(opening.child.terminate).toHaveBeenCalledOnce()

    const hanging = (): Script => standardScript(() => {})
    const timed = runner(hanging(), { timeoutMs: 5 })
    await expect(collect(timed.runner, request())).rejects.toMatchObject({ code: 'TIMEOUT' })

    const controller = new AbortController()
    const cancelled = runner(hanging())
    const pending = collect(cancelled.runner, request({ signal: controller.signal }))
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('tears down when the stream consumer returns after the first event', async () => {
    const setup = runner(standardScript(() => {}))
    const iterator = setup.runner.stream(request())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'thread-started', threadId: 'thread-1' },
    })
    await iterator.return?.()

    expect(existsSync(setup.spec().cwd)).toBe(false)
    expect(setup.child.terminate).toHaveBeenCalledOnce()
    expect(setup.child.waitForExit).toHaveBeenCalledOnce()
  })

  it('rejects a mismatched App Server version and malformed JSON-RPC', async () => {
    const mismatched = runner((message, send) => {
      if (message.method === 'initialize') {
        send({ id: message.id, result: { userAgent: 'codex_app_server/0.148.0' } })
      }
    })
    await expect(collect(mismatched.runner, request())).rejects.toMatchObject({ code: 'PROTOCOL_VERSION' })
    expect(mismatched.child.terminate).toHaveBeenCalledOnce()

    const malformed = runner((message, send, sendRaw) => {
      standardScript(() => {})(message, send, sendRaw)
      if (message.method === 'turn/start') sendRaw('{not-json}\n')
    })
    await expect(collect(malformed.runner, request())).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(malformed.child.terminate).toHaveBeenCalledOnce()
  })

  it('accepts a long protocol stream whose individual JSON-RPC lines stay bounded', async () => {
    const setup = runner(standardScript((send) => {
      for (let index = 0; index < 20; index += 1) {
        send({ method: 'item/agentMessage/delta', params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'message-1',
          delta: `${String(index)}:${'x'.repeat(256)}`,
        } })
      }
      send({ method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null },
      } })
    }), { maxJsonRpcLineBytes: 512 })

    const events = await collect(setup.runner, request())
    expect(events.filter(event => (
      event.kind === 'notification' && event.method === 'item/agentMessage/delta'
    ))).toHaveLength(20)
    expect(setup.child.terminate).toHaveBeenCalledOnce()
  })

  it('bounds each App Server JSON-RPC line', async () => {
    const setup = runner(standardScript((send) => {
      send({ method: 'item/agentMessage/delta', params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'message-1',
        delta: 'x'.repeat(2_000),
      } })
    }), { maxJsonRpcLineBytes: 512 })

    await expect(collect(setup.runner, request())).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' })
    expect(setup.child.terminate).toHaveBeenCalledOnce()
  })

  it('rejects unsafe model and provider ids before spawning', async () => {
    const spawn = vi.fn(() => scriptedHandle(() => {}))
    const instance = new CodexAppServerRunner({
      timeoutMs: 1_000,
      disposeGraceMs: 25,
      maxJsonRpcLineBytes: 1_000,
      maxStderrBytes: 1_000,
      env: {},
      spawn,
    })
    await expect(collect(instance, request({ model: '--config' }))).rejects.toMatchObject({ code: 'INVALID_MODEL' })
    await expect(collect(instance, request({ modelProvider: '--provider' }))).rejects.toMatchObject({
      code: 'INVALID_PROVIDER',
    })
    expect(spawn).not.toHaveBeenCalled()
  })
})
