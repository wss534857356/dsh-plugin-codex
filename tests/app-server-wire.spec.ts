import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { codexCliEntry } from '../src/runner.ts'

const HARNESS_SYSTEM = 'HARNESS_SYSTEM_SENTINEL\nOnly Harness instructions may control this request.'
const HARNESS_TOOL = 'harness_probe'
const HARNESS_TOOL_SENTINEL = 'HARNESS_TOOL_SENTINEL'
const HOSTILE_CONFIG_SENTINEL = 'HOSTILE_CODEX_CONFIG_SENTINEL'
const TOOL_CALL_ID = 'harness-call-1'
const TOOL_RESULT_SENTINEL = 'HARNESS_TOOL_RESULT_SENTINEL'
const MODEL = 'gpt-5.6-sol'
const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

interface CapturedRequest {
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: unknown
}

interface JsonObject {
  readonly [key: string]: unknown
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value as JsonObject
}

function processEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = [
    'APPDATA',
    'ComSpec',
    'HOME',
    'LANG',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR',
  ]
  return Object.fromEntries([
    ...inherited.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
    ...Object.entries(overrides),
  ])
}

function namedValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(namedValues)
  if (value === null || typeof value !== 'object') return []
  const candidate = value as JsonObject
  return [
    ...(typeof candidate.name === 'string' ? [candidate.name] : []),
    ...Object.values(candidate).flatMap(namedValues),
  ]
}

class AppServerClient {
  private readonly pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>()
  private readonly stderr: string[] = []
  private nextId = 1

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      const envelope = object(message, 'App Server message')
      if (typeof envelope.id !== 'number') return
      const waiter = this.pending.get(envelope.id)
      if (waiter === undefined) return
      this.pending.delete(envelope.id)
      if (envelope.error !== undefined) {
        waiter.reject(new Error(`App Server error: ${JSON.stringify(envelope.error)}`))
      } else {
        waiter.resolve(envelope.result)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderr.push(chunk) })
    child.once('exit', (code, signal) => {
      const detail = this.stderr.join('').trim()
      const error = new Error(`App Server exited with ${String(code)}/${String(signal)}${detail === '' ? '' : `: ${detail}`}`)
      for (const waiter of this.pending.values()) waiter.reject(error)
      this.pending.clear()
    })
  }

  notify(method: string, params: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  async request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++
    const waiter = Promise.withResolvers<unknown>()
    this.pending.set(id, waiter)
    this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    return waiter.promise
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = Promise.withResolvers<void>()
  child.once('exit', () => { exited.resolve() })
  child.stdin.end()
  const timer = setTimeout(() => { child.kill() }, 2_000)
  await exited.promise
  clearTimeout(timer)
}

describe('Codex App Server wire ownership', () => {
  it('replays injected history through an empty turn while retaining Codex-owned layers', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-wire-proof-'))
    const home = join(root, 'codex-home')
    const workspace = join(root, 'workspace')
    await mkdir(home)
    await mkdir(workspace)

    const captured = Promise.withResolvers<CapturedRequest>()
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        captured.resolve({
          url: request.url ?? '',
          headers: request.headers,
          body: JSON.parse(text),
        })
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"wire proof complete"}}')
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('wire proof server has no TCP address')

    await writeFile(join(home, 'config.toml'), [
      `model = "${MODEL}"`,
      'model_provider = "wire-proof"',
      `developer_instructions = "${HOSTILE_CONFIG_SENTINEL}"`,
      'personality = "friendly"',
      'check_for_update_on_startup = false',
      '[analytics]',
      'enabled = false',
      '[model_providers.wire-proof]',
      'name = "Wire proof"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'env_key = "WIRE_PROOF_API_KEY"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      'stream_idle_timeout_ms = 10000',
      '',
    ].join('\n'))

    const child = spawn(process.execPath, [
      codexCliEntry(),
      'app-server',
      '--stdio',
      '--strict-config',
      '--disable', 'apps',
      '--disable', 'browser_use',
      '--disable', 'browser_use_external',
      '--disable', 'browser_use_full_cdp_access',
      '--disable', 'code_mode',
      '--disable', 'code_mode_buffered_exec',
      '--disable', 'code_mode_host',
      '--disable', 'code_mode_only',
      '--disable', 'computer_use',
      '--disable', 'hooks',
      '--disable', 'image_generation',
      '--disable', 'in_app_browser',
      '--disable', 'mcp_2026_07_28',
      '--disable', 'multi_agent',
      '--disable', 'multi_agent_v2',
      '--disable', 'plugins',
      '--disable', 'remote_plugin',
      '--disable', 'request_permissions_tool',
      '--disable', 'shell_tool',
      '--disable', 'skill_search',
      '--disable', 'standalone_web_search',
      '--disable', 'tool_call_mcp_elicitation',
      '--disable', 'unified_exec',
      '--disable', 'view_image',
      '--disable', 'web_search_cached',
      '--disable', 'web_search_request',
    ], {
      cwd: workspace,
      env: processEnvironment({
        CODEX_HOME: home,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'deepseek-harness-wire-proof',
        NO_PROXY: '127.0.0.1,localhost',
        WIRE_PROOF_API_KEY: 'not-a-secret',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client = new AppServerClient(child)
    cleanups.push(async () => { await stop(child) })
    cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => { resolve() })) })
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })

    await client.request('initialize', {
      clientInfo: { name: 'deepseek-harness-wire-proof', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    client.notify('initialized', {})
    const listed = object(await client.request('skills/list', {
      cwds: [workspace],
      forceReload: true,
    }), 'skills/list result')
    const skillGroups = Array.isArray(listed.data) ? listed.data : []
    for (const candidate of skillGroups) {
      const group = object(candidate, 'skills/list group')
      const skills = Array.isArray(group.skills) ? group.skills : []
      for (const skillCandidate of skills) {
        const skill = object(skillCandidate, 'skills/list skill')
        if (typeof skill.path !== 'string') throw new Error('skills/list skill has no path')
        await client.request('skills/config/write', { path: skill.path, enabled: false })
      }
    }
    const started = object(await client.request('thread/start', {
      model: MODEL,
      modelProvider: 'wire-proof',
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: HARNESS_SYSTEM,
      developerInstructions: '',
      personality: 'none',
      environments: [],
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      dynamicTools: [{
        type: 'namespace',
        name: 'deepseek_harness',
        description: 'Tools provided by the outer DeepSeek Harness agent loop.',
        tools: [{
          type: 'function',
          name: HARNESS_TOOL,
          description: HARNESS_TOOL_SENTINEL,
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        }],
      }],
      ephemeral: true,
    }), 'thread/start result')
    const thread = object(started.thread, 'thread/start thread')
    expect(started.instructionSources ?? []).toEqual([])

    await client.request('thread/inject_items', {
      threadId: String(thread.id),
      items: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'USER_REQUEST_SENTINEL' },
            { type: 'input_image', image_url: IMAGE_DATA_URL, detail: 'auto' },
          ],
        },
        {
          type: 'function_call',
          call_id: TOOL_CALL_ID,
          namespace: 'deepseek_harness',
          name: HARNESS_TOOL,
          arguments: '{"value":"from-history"}',
        },
        {
          type: 'function_call_output',
          call_id: TOOL_CALL_ID,
          output: TOOL_RESULT_SENTINEL,
        },
      ],
    })
    await client.request('turn/start', {
      threadId: String(thread.id),
      input: [],
    })
    const capturedRequest = await captured.promise
    const request = object(capturedRequest.body, 'captured Responses request')
    expect(capturedRequest.url).toBe('/v1/responses')
    expect(request.instructions).toBeUndefined()
    expect(request.input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message',
        role: 'user',
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'input_text', text: 'USER_REQUEST_SENTINEL' }),
          expect.objectContaining({ type: 'input_image', image_url: IMAGE_DATA_URL }),
        ]),
      }),
      expect.objectContaining({
        type: 'function_call',
        call_id: TOOL_CALL_ID,
        namespace: 'deepseek_harness',
        name: HARNESS_TOOL,
        arguments: '{"value":"from-history"}',
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: TOOL_CALL_ID,
        output: TOOL_RESULT_SENTINEL,
      }),
    ]))

    const wire = JSON.stringify(request)
    expect(wire).toContain('HARNESS_SYSTEM_SENTINEL')
    expect(wire).toContain('USER_REQUEST_SENTINEL')
    expect(wire).toContain(IMAGE_DATA_URL)
    expect(wire).toContain(TOOL_CALL_ID)
    expect(wire).toContain(TOOL_RESULT_SENTINEL)
    expect(wire).toContain(HARNESS_TOOL)
    expect(wire).toContain(HARNESS_TOOL_SENTINEL)
    expect(wire).not.toContain(HOSTILE_CONFIG_SENTINEL)
    expect(wire).not.toContain('<skills_instructions>')

    expect(wire).toContain('<permissions instructions>')
    expect(wire).toContain('You are `/root`, the primary agent')
    expect(wire).toContain('<multi_agent_mode>')
    expect(wire).toContain('<environment_context>')
    expect(namedValues(request.input)).toEqual(expect.arrayContaining([
      'functions',
      'exec',
      'wait',
      'request_user_input',
      'collaboration',
      'spawn_agent',
    ]))
  })
})
