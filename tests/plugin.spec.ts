import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as CodexAppServer from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function context(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx
}

describe('plugin composition', () => {
  it('materializes the default model catalog through Cordis config parsing', async () => {
    const ctx = await context()
    await ctx.plugin(CodexAppServer, {})

    expect(ctx.llm.listProviders()).toContainEqual({
      id: 'codex-local',
      name: 'Codex (local login)',
    })
    const models = await ctx.llm.listModels('codex-local')
    expect(models.map(model => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ])
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'codex-local',
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6-Terra',
        inputModalities: ['text'],
      }),
      expect.objectContaining({
        provider: 'codex-local',
        id: 'gpt-5.3-codex-spark',
        name: 'GPT-5.3-Codex-Spark',
        inputModalities: ['text'],
      }),
    ]))
    await expect(ctx.llm.resolveModelInfo('codex-local', 'gpt-5.6-terra')).resolves.toMatchObject({
      context: { contextWindow: 258_400 },
      reasoning: { defaultEffort: 'medium' },
    })
    await expect(ctx.llm.resolveModelInfo('codex-local', 'gpt-5.3-codex-spark')).resolves.toMatchObject({
      context: { contextWindow: 121_600 },
      reasoning: { defaultEffort: 'high' },
    })
  })

  it('rejects an explicitly empty model catalog', async () => {
    const ctx = await context()
    await expect(ctx.plugin(CodexAppServer, { models: [] })).rejects.toThrow('models must not be empty')
  })
})
