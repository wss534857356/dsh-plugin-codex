import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { CodexRunner, codexArgv, codexCliEntry } from '../src/runner.ts'

function handle(
  stdout = 'stdout',
  stderr = 'stderr',
  done: Promise<SubprocessOutcome> = Promise.resolve({ exitCode: 0, signal: null }),
  waitForExit: SubprocessHandle['waitForExit'] = vi.fn(async () => true),
): SubprocessHandle {
  return {
    pid: 123,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
    },
    done,
    terminate: vi.fn(),
    waitForExit,
  }
}

describe('Codex process runner', () => {
  it('uses the pinned CLI entry and fixed non-shell policy', () => {
    expect(existsSync(codexCliEntry())).toBe(true)
    const argv = codexArgv({ model: 'gpt-5.6-sol', reasoningEffort: 'high' })
    expect(argv.slice(0, 3)).toEqual([process.execPath, codexCliEntry(), 'exec'])
    expect(argv).toContain('--json')
    expect(argv).toContain('--ephemeral')
    expect(argv).toContain('--ignore-user-config')
    expect(argv).toContain('--ignore-rules')
    expect(argv).toContain('--strict-config')
    expect(argv).toContain('read-only')
    expect(argv).toContain('approval_policy="never"')
    expect(argv).toContain('check_for_update_on_startup=false')
    expect(argv).toContain('analytics.enabled=false')
    expect(argv).toContain('model_reasoning_effort="high"')
    expect(argv.at(-1)).toBe('-')
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it.each([
    { model: '--dangerously-bypass-approvals-and-sandbox' },
    { model: 'gpt-5.6-sol', reasoningEffort: '--config' },
  ])('rejects an identifier that the CLI could parse as another option %#', (request) => {
    expect(() => codexArgv(request)).toThrowError(expect.objectContaining({
      code: request.model.startsWith('--') ? 'INVALID_MODEL' : 'UNSUPPORTED_REASONING_EFFORT',
    }))
  })

  it('spawns in a private temporary directory and reaches process-tree quiescence', async () => {
    const child = handle('events', 'diagnostic')
    let spec: SubprocessSpawnSpec | undefined
    const runner = new CodexRunner({
      timeoutMs: 1_000,
      disposeGraceMs: 25,
      maxStdoutBytes: 100,
      maxStderrBytes: 50,
      env: { CODEX_HOME: 'configured-home' },
      spawn: candidate => {
        spec = candidate
        expect(existsSync(candidate.cwd)).toBe(true)
        return child
      },
    })
    await expect(runner.run({ model: 'gpt-5.6-sol', prompt: 'prompt' })).resolves.toEqual({
      stdout: 'events',
      stderr: 'diagnostic',
      exitCode: 0,
      signal: null,
    })
    expect(spec).toMatchObject({
      stdio: {
        stdin: { data: 'prompt' },
        stdout: { maxBytes: 100 },
        stderr: { maxBytes: 50 },
      },
      graceMs: 25,
      env: {
        CODEX_HOME: 'configured-home',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'deepseek-harness',
      },
    })
    expect(existsSync(spec!.cwd)).toBe(false)
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledOnce()
  })

  it('classifies deadline and caller cancellation separately', async () => {
    const run = async (timeoutMs: number, signal?: AbortSignal) => {
      let resolveDone!: (outcome: SubprocessOutcome) => void
      const done = new Promise<SubprocessOutcome>(resolve => { resolveDone = resolve })
      const runner = new CodexRunner({
        timeoutMs,
        disposeGraceMs: 10,
        maxStdoutBytes: 100,
        maxStderrBytes: 100,
        env: {},
        spawn: (spec) => {
          const settle = (): void => {
            resolveDone({ exitCode: null, signal: 'SIGTERM' })
          }
          if (spec.signal?.aborted) settle()
          else spec.signal?.addEventListener('abort', settle, { once: true })
          return handle('', '', done)
        },
      })
      return runner.run({ model: 'gpt-5.6-sol', prompt: 'prompt', ...(signal === undefined ? {} : { signal }) })
    }
    await expect(run(5)).rejects.toMatchObject({ code: 'TIMEOUT' })
    const controller = new AbortController()
    const pending = run(1_000, controller.signal)
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('reports cleanup failure without hiding the primary failure code', async () => {
    const cleanupFailure = new Error('process-tree inspection failed')
    let resolveDone!: (outcome: SubprocessOutcome) => void
    const done = new Promise<SubprocessOutcome>(resolve => { resolveDone = resolve })
    const runner = new CodexRunner({
      timeoutMs: 5,
      disposeGraceMs: 10,
      maxStdoutBytes: 100,
      maxStderrBytes: 100,
      env: {},
      spawn: (spec) => {
        spec.signal?.addEventListener('abort', () => {
          resolveDone({ exitCode: null, signal: 'SIGTERM' })
        }, { once: true })
        return handle('', '', done, vi.fn(async () => { throw cleanupFailure }))
      },
    })

    await expect(runner.run({ model: 'gpt-5.6-sol', prompt: 'prompt' })).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('process-tree inspection failed'),
      cause: expect.any(AggregateError),
    })
  })

  it('classifies cleanup-only failure as transport failure', async () => {
    const runner = new CodexRunner({
      timeoutMs: 1_000,
      disposeGraceMs: 10,
      maxStdoutBytes: 100,
      maxStderrBytes: 100,
      env: {},
      spawn: () => handle('ok', '', undefined, vi.fn(async () => false)),
    })

    await expect(runner.run({ model: 'gpt-5.6-sol', prompt: 'prompt' })).rejects.toMatchObject({
      code: 'TRANSPORT',
      message: expect.stringContaining('did not reach quiescence'),
    })
  })
})
