import { renderToStaticMarkup } from 'react-dom/server'
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, vi } from 'vitest'
import type { CodexActionBlock } from '../src/protocol.ts'
import {
  actionSummary,
  CodexActionCard,
  CodexAssistantBody,
  isCodexActionBlock,
} from '../src/client/CodexAssistantNodeView.tsx'
import { apply } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Readonly<Record<string, string>>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match)
}) as TranslateNS<typeof NS>

function lifecycleBlock(): CodexActionBlock {
  return {
    type: 'codex-action',
    actionId: '019ffe6a-2b42-7141-8f98-f6c6b4550027',
    actionType: 'thread/start',
    category: 'lifecycle',
    phase: 'completed',
    protocolEvent: 'thread/start',
    snapshot: {
      ownership: 'layered',
      codexOwnedPromptAndTools: true,
      instructionSources: [{ path: 'C:/Users/demo/.codex/AGENTS.md' }],
      threadId: 'thread-1',
    },
  }
}

describe('Codex Assistant renderer', () => {
  it('recognizes only complete provider trajectory records', () => {
    expect(isCodexActionBlock(lifecycleBlock())).toBe(true)
    expect(isCodexActionBlock({ ...lifecycleBlock(), phase: 'mystery' })).toBe(false)
    expect(isCodexActionBlock({ type: 'codex-action', actionId: 'short' })).toBe(false)
  })

  it('interprets thread/start as layered control and retains protocol identity', () => {
    const block = lifecycleBlock()
    expect(actionSummary(block, t)).toContain('分层共治')
    expect(actionSummary(block, t)).toContain('1 个指令源')

    const html = renderToStaticMarkup(<CodexActionCard block={block} t={t} />)
    expect(html).toContain('data-codex-action="thread/start"')
    expect(html).toContain('启动原生会话')
    expect(html).toContain('协议事件')
    expect(html).toContain('019ffe6a-2b42-7141-8f98-f6c6b4550027')
    expect(html).toContain('完整 Codex 协议记录')
    expect(html).not.toContain('未知内容块')
  })

  it('specializes codex-action while preserving the generic fallback', () => {
    const actionOnly: readonly AssistantBlock[] = [{ kind: 'other', block: lifecycleBlock() }]
    const actionHtml = renderToStaticMarkup(
      <CodexAssistantBody blocks={actionOnly} streaming={false} t={t} />,
    )
    expect(actionHtml).toContain('data-codex-assistant-renderer="true"')
    expect(actionHtml).toContain('Codex 生命周期')
    expect(actionHtml).not.toContain('未知内容块')

    const generic: readonly AssistantBlock[] = [{ kind: 'other', block: { type: 'future-block' } }]
    const genericHtml = renderToStaticMarkup(
      <CodexAssistantBody blocks={generic} streaming={false} t={t} />,
    )
    expect(genericHtml).toContain('未知内容块')
  })

  it('shadows the stock assistant cell without replacing its slot declaration', () => {
    const register = vi.fn(() => () => {})
    const localeRegister = vi.fn(() => () => {})
    const ctx = {
      effect(factory: () => () => void) {
        factory()
      },
      locale: { register: localeRegister },
      slots: {
        inject(_name: string, factory: () => () => void) {
          factory()
        },
        register,
      },
    } as unknown as Context

    apply(ctx)

    expect(localeRegister).toHaveBeenCalledWith(NS, { zh, en })
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.chat.node',
      key: 'assistant-step',
      priority: -10,
      locale: NS,
    }), expect.any(Object))
  })
})
