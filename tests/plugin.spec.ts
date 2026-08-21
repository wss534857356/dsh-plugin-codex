import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as CodexAppServer from '../src/index.ts'

const contexts: Context[] = []

class MemorySettings extends SettingsProvider {
  private readonly doc: Record<string, unknown> = {}

  override get writable(): boolean {
    return true
  }

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function context(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
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
        inputModalities: ['text', 'image'],
      }),
      expect.objectContaining({
        provider: 'codex-local',
        id: 'gpt-5.3-codex-spark',
        name: 'GPT-5.3-Codex-Spark',
        inputModalities: ['text'],
      }),
    ]))
    await expect(ctx.llm.resolveModelInfo('codex-local', 'gpt-5.6-terra')).resolves.toMatchObject({
      inputModalities: ['text', 'image'],
      context: { contextWindow: 1_050_000 },
      reasoning: { defaultEffort: 'medium' },
    })
    await expect(ctx.llm.resolveModelInfo('codex-local', 'gpt-5.4-mini')).resolves.toMatchObject({
      context: { contextWindow: 400_000 },
      reasoning: { defaultEffort: 'medium' },
    })
    await expect(ctx.llm.resolveModelInfo('codex-local', 'gpt-5.3-codex-spark')).resolves.toMatchObject({
      context: { contextWindow: 128_000 },
      reasoning: { defaultEffort: 'high' },
    })
  })

  it('defaults custom routes to text-only and rejects duplicate modalities', async () => {
    const ctx = await context()
    await ctx.plugin(CodexAppServer, {
      models: [{ id: 'custom-model', name: 'Custom' }],
    })
    await expect(ctx.llm.resolveModelInfo('codex-local', 'custom-model')).resolves.toMatchObject({
      inputModalities: ['text'],
    })

    const invalid = await context()
    await expect(invalid.plugin(CodexAppServer, {
      models: [{
        id: 'invalid-model',
        name: 'Invalid',
        inputModalities: ['text', 'text'],
      }],
    })).rejects.toThrow('invalid inputModalities')
  })

  it('rejects an explicitly empty model catalog', async () => {
    const ctx = await context()
    await expect(ctx.plugin(CodexAppServer, { models: [] })).rejects.toThrow('models must not be empty')
  })

  it('rejects a non-positive Codex web-search result cap', async () => {
    const ctx = await context()
    await expect(ctx.plugin(CodexAppServer, { webSearchMaxResults: 0 }))
      .rejects.toThrow(/webSearchMaxResults.*>= 1/u)
  })

  it('delegates web_search unchanged for a non-Codex initiating Agent', async () => {
    const ctx = await context()
    await ctx.plugin(CodexAppServer, {})
    const downstream = {
      isError: false as const,
      value: null,
      content: [],
    }
    const next = vi.fn(async () => downstream)
    const result = await ctx.waterfall(
      ctx as never,
      'tools/execute',
      {
        name: 'web_search',
        arguments: { queries: ['query'] },
        signal: new AbortController().signal,
        agent: {
          options: { provider: 'another-provider', model: 'another-model' },
          session: { requestHeader: () => undefined },
        },
      } as never,
      next,
    )

    expect(result).toBe(downstream)
    expect(next).toHaveBeenCalledOnce()
  })

  it('registers live capability settings and stops taking over search when disabled', async () => {
    const ctx = await context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(CodexAppServer, {})

    expect(ctx.settings.describe().find(entry => entry.ns === CodexAppServer.CODEX_SETTINGS_NAMESPACE))
      .toMatchObject({
        value: {
          imageGenerationEnabled: true,
          webSearchEnabled: true,
          webSearchMaxResults: 8,
        },
        applies: 'live',
      })
    await ctx.settings.update(CodexAppServer.CODEX_SETTINGS_NAMESPACE, {
      imageGenerationEnabled: false,
      webSearchEnabled: false,
      webSearchModel: 'gpt-5.4-mini',
      webSearchMaxResults: 3,
    })

    const downstream = { isError: false as const, value: null, content: [] }
    const next = vi.fn(async () => downstream)
    await expect(ctx.waterfall(
      ctx as never,
      'tools/execute',
      {
        name: 'web_search',
        arguments: { queries: ['query'] },
        signal: new AbortController().signal,
        agent: {
          options: { provider: 'codex-local', model: 'gpt-5.6-sol' },
          session: { requestHeader: () => undefined },
        },
      } as never,
      next,
    )).resolves.toBe(downstream)
    expect(next).toHaveBeenCalledOnce()

    await expect(ctx.settings.update(CodexAppServer.CODEX_SETTINGS_NAMESPACE, {
      webSearchModel: '../unsafe model',
    })).rejects.toThrow(/webSearchModel/u)
  })
})
