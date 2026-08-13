import { describe, expect, it, vi } from 'vitest'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CodexExecAdapter } from '../src/adapter.ts'
import type { CodexRunOutput, CodexRunnerPort, CodexRunRequest } from '../src/runner.ts'

const success: CodexRunOutput = {
  stdout: [
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '{"kind":"message","text":"hello","calls":[]}',
      },
    }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n'),
  stderr: '',
  exitCode: 0,
  signal: null,
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'codex-local',
    model: 'gpt-5.6-sol',
    messages: [{
      id: MessageId('user-1'),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    }],
    ...overrides,
  }
}

function adapter(output: CodexRunOutput = success) {
  const run = vi.fn(async (_request: CodexRunRequest) => output)
  const runner: CodexRunnerPort = { run }
  return {
    run,
    adapter: new CodexExecAdapter({
      provider: 'codex-local',
      displayName: 'Codex local',
      models: [{
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        contextWindow: 272_000,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'low',
      }],
      maxRetries: 0,
      runner,
    }),
  }
}

async function collect(instance: CodexExecAdapter, options: GenerateOptions) {
  const chunks = []
  for await (const chunk of instance.stream(options)) chunks.push(chunk)
  return chunks
}

describe('CodexExecAdapter', () => {
  it('advertises the provider, model, context, reasoning, and no retries', async () => {
    const { adapter: instance } = adapter()
    expect(instance.providerInfo('codex-local')).toEqual({ id: 'codex-local', name: 'Codex local' })
    expect(instance.providerRetryPolicy('codex-local')).toMatchObject({
      mode: 'normal',
      maxRetries: 0,
    })
    expect(await instance.listModels('codex-local')).toEqual([{
      provider: 'codex-local',
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      inputModalities: ['text'],
    }])
    expect(await instance.resolveModel('codex-local', 'gpt-5.6-sol')).toMatchObject({
      context: { contextWindow: 272_000 },
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        defaultEffort: 'low',
      },
    })
  })

  it('runs one model request and emits a complete chunk sequence', async () => {
    const { adapter: instance, run } = adapter()
    const chunks = await collect(instance, request({ reasoningEffort: ReasoningEffortId('high') }))
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]![0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    })
    expect(run.mock.calls[0]![0].prompt).toContain('HARNESS_REQUEST_JSON')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it.each([
    { temperature: 0 },
    { maxTokens: 10 },
    { stop: ['END'] },
  ] satisfies Array<Partial<GenerateOptions>>)('rejects unsupported CLI option %#', async (override) => {
    const { adapter: instance, run } = adapter()
    await expect(collect(instance, request(override))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(run).not.toHaveBeenCalled()
  })

  it('maps nonzero process exit details', async () => {
    const { adapter: instance } = adapter({
      stdout: '',
      stderr: 'status 429: too many requests',
      exitCode: 1,
      signal: null,
    })
    await expect(collect(instance, request())).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })
})
