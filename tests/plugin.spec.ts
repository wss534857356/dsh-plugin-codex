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
    expect(await ctx.llm.listModels('codex-local')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'codex-local',
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        inputModalities: ['text'],
      }),
    ]))
  })

  it('rejects an explicitly empty model catalog', async () => {
    const ctx = await context()
    await expect(ctx.plugin(CodexAppServer, { models: [] })).rejects.toThrow('models must not be empty')
  })
})
