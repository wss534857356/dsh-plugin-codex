/** Managed `codex exec --json` process lifecycle. */

import { createRequire } from 'node:module'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SAFE_MODEL_ID, SAFE_REASONING_EFFORT } from './identifiers.ts'

const WORKDIR_PREFIX = 'dsh-codex-llm-'
const TIMEOUT_REASON = Symbol('codex-exec-timeout')
const CONSUMER_REASON = Symbol('codex-exec-consumer-stop')
const CODEX_DISABLED_FEATURES = [
  'apps',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_buffered_exec',
  'code_mode_host',
  'code_mode_only',
  'computer_use',
  'hooks',
  'image_generation',
  'in_app_browser',
  'js_repl',
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
  'web_search_cached',
  'web_search_request',
] as const

/** Inputs resolved once for one Codex process. */
export interface CodexRunRequest {
  readonly model: string
  readonly reasoningEffort?: string
  readonly prompt: string
  readonly signal?: AbortSignal
}

/** Complete bounded process output. */
export interface CodexRunOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

/** Deployment values for the process boundary. */
export interface CodexRunnerOptions {
  readonly timeoutMs: number
  readonly disposeGraceMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly env: Readonly<Record<string, string>>
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

/** Testable runner contract used by the adapter. */
export interface CodexRunnerPort {
  run(request: CodexRunRequest): Promise<CodexRunOutput>
}

function packageFile(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url))
}

/** Resolve the pinned official CLI's JavaScript entry without a shell lookup. */
export function codexCliEntry(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js')
}

/** Build the fixed, non-shell Codex argv for one request. */
export function codexArgv(request: Pick<CodexRunRequest, 'model' | 'reasoningEffort'>): string[] {
  if (!SAFE_MODEL_ID.test(request.model)) {
    throw new LlmError(`Codex model is not a safe CLI identifier: ${JSON.stringify(request.model)}`, 'INVALID_MODEL')
  }
  if (request.reasoningEffort !== undefined && !SAFE_REASONING_EFFORT.test(request.reasoningEffort)) {
    throw new LlmError(
      `Codex reasoning effort is not a safe CLI identifier: ${JSON.stringify(request.reasoningEffort)}`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  const disabled = CODEX_DISABLED_FEATURES.flatMap(feature => ['--disable', feature])
  return [
    process.execPath,
    codexCliEntry(),
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    'analytics.enabled=false',
    ...disabled,
    '--model',
    request.model,
    ...(request.reasoningEffort === undefined
      ? []
      : ['-c', `model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`]),
    '--output-schema',
    packageFile('../schemas/response.json'),
    '-',
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
    throw new Error('refusing to remove an unexpected Codex bridge directory')
  }
  await rm(path, { recursive: true, force: true })
}

function readCollected(child: SubprocessHandle, stream: 'stdout' | 'stderr'): string {
  const reader = child.collected[stream]
  if (reader === undefined) throw new Error(`Codex bridge did not collect ${stream}`)
  const read = reader.readFrom(0)
  if (read.lossy) throw new LlmError(`Codex ${stream} exceeded its configured capture limit`, 'OUTPUT_LIMIT')
  return read.text
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

async function cleanupRun(child: SubprocessHandle | undefined, workdir: string): Promise<Error[]> {
  const failures: Error[] = []
  if (child !== undefined) {
    try {
      child.terminate()
    } catch (error: unknown) {
      failures.push(thrown(error))
    }
    try {
      if (!await child.waitForExit()) failures.push(new Error('Codex process tree did not reach quiescence'))
    } catch (error: unknown) {
      failures.push(thrown(error))
    }
    // The request body already observes `done`; this await only keeps teardown settled.
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
    return new LlmError(`Codex process cleanup failed: ${detail}`, 'TRANSPORT', {
      cause: new AggregateError(failures, 'Codex process cleanup failed'),
    })
  }
  return new LlmError(`${primary.message}; Codex cleanup also failed: ${detail}`, primary.code, {
    cause: new AggregateError([primary, ...failures], 'Codex request and cleanup failed'),
  })
}

/** One-process-per-request runner with bounded capture and tree-scoped teardown. */
export class CodexRunner implements CodexRunnerPort {
  constructor(private readonly options: CodexRunnerOptions) {}

  async run(request: CodexRunRequest): Promise<CodexRunOutput> {
    const argv = codexArgv(request)
    let workdir: string
    try {
      workdir = await privateWorkdir()
    } catch (error: unknown) {
      throw new LlmError('Codex private working directory setup failed', 'TRANSPORT', { cause: thrown(error) })
    }
    const lifetime = new AbortController()
    const signal = request.signal === undefined
      ? lifetime.signal
      : AbortSignal.any([request.signal, lifetime.signal])
    const timeout = setTimeout(() => { lifetime.abort(TIMEOUT_REASON) }, this.options.timeoutMs)
    let child: SubprocessHandle | undefined
    let output: CodexRunOutput | undefined
    let failure: LlmError | undefined
    try {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error(`Codex request aborted before process startup: ${String(signal.reason)}`)
      }
      child = this.options.spawn({
        argv,
        cwd: workdir,
        stdio: {
          stdin: { data: request.prompt },
          stdout: { maxBytes: this.options.maxStdoutBytes },
          stderr: { maxBytes: this.options.maxStderrBytes },
        },
        graceMs: this.options.disposeGraceMs,
        signal,
        env: {
          ...this.options.env,
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'deepseek-harness',
        },
      })
      const outcome = await child.done
      if (lifetime.signal.reason === TIMEOUT_REASON) {
        throw new LlmError(`Codex request timed out after ${this.options.timeoutMs}ms`, 'TIMEOUT')
      }
      if (request.signal?.aborted) {
        throw new LlmError('Codex request aborted by caller', 'ABORTED', {
          cause: request.signal.reason,
        })
      }
      output = {
        stdout: readCollected(child, 'stdout'),
        stderr: readCollected(child, 'stderr'),
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      }
    } catch (error: unknown) {
      if (lifetime.signal.reason === TIMEOUT_REASON) {
        failure = new LlmError(`Codex request timed out after ${this.options.timeoutMs}ms`, 'TIMEOUT', { cause: error })
      } else if (request.signal?.aborted) {
        failure = new LlmError('Codex request aborted by caller', 'ABORTED', { cause: error })
      } else if (error instanceof LlmError) {
        failure = error
      } else {
        failure = new LlmError('Codex process failed', 'TRANSPORT', { cause: thrown(error) })
      }
    }
    clearTimeout(timeout)
    if (!lifetime.signal.aborted) lifetime.abort(CONSUMER_REASON)
    failure = cleanupError(failure, await cleanupRun(child, workdir))
    if (failure !== undefined) throw failure
    if (output === undefined) throw new LlmError('Codex process completed without an outcome', 'TRANSPORT')
    return output
  }
}
