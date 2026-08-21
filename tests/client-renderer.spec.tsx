import { renderToStaticMarkup } from 'react-dom/server'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, vi } from 'vitest'
import type { CodexActionBlock } from '../src/protocol.ts'
import {
  actionSummary,
  codexActionView,
  CodexActionDetails,
  CodexActionRow,
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
  const renderMessageImages = vi.fn(() => null)

  it('recognizes only complete provider trajectory records', () => {
    expect(isCodexActionBlock(lifecycleBlock())).toBe(true)
    expect(isCodexActionBlock({ ...lifecycleBlock(), phase: 'mystery' })).toBe(false)
    expect(isCodexActionBlock({ type: 'codex-action', actionId: 'short' })).toBe(false)
  })

  it('interprets thread/start as layered control and retains protocol identity', () => {
    const block = lifecycleBlock()
    const action = codexActionView(block)
    expect(action).toBeDefined()
    expect(actionSummary(action!, t)).toContain('分层共治')
    expect(actionSummary(action!, t)).toContain('1 个指令源')

    const html = renderToStaticMarkup(<CodexActionRow active={false} action={action!} t={t} />)
    expect(html).toContain('data-codex-action="thread/start"')
    expect(html).toContain('data-disclosure-row="true"')
    expect(html).toContain('<svg')
    expect(html).not.toContain('data-state="done"')
    expect(html).toContain('启动原生会话')
    expect(html).not.toContain('未知内容块')

    const detailsHtml = renderToStaticMarkup(<CodexActionDetails action={action!} t={t} />)
    expect(detailsHtml).toContain('协议事件')
    expect(detailsHtml).toContain('019ffe6a-2b42-7141-8f98-f6c6b4550027')
    expect(detailsHtml).toContain('aria-label="完整 Codex 协议记录"')
  })

  it.each([
    { phase: 'requested', active: true, state: 'ongoing' },
    { phase: 'started', active: true, state: 'ongoing' },
  ] as const)('maps active $phase to $state', ({ phase, active, state }) => {
    const action = codexActionView({ ...lifecycleBlock(), phase })
    const html = renderToStaticMarkup(<CodexActionRow active={active} action={action!} t={t} />)
    expect(html).toContain(`data-state="${state}"`)
  })

  it.each([
    { actionType: 'thread/start', category: 'lifecycle', phase: 'completed' },
    { actionType: 'context/injected', category: 'context', phase: 'completed' },
    { actionType: 'turn/plan/updated', category: 'action', phase: 'updated' },
    { actionType: 'item/tool/requestUserInput', category: 'action', phase: 'requested' },
  ] as const)('uses a neutral icon for settled $actionType trajectory', ({ actionType, category, phase }) => {
    const action = codexActionView({ ...lifecycleBlock(), actionType, category, phase })
    const html = renderToStaticMarkup(<CodexActionRow active={false} action={action!} t={t} />)
    expect(html).toContain('<svg')
    expect(html).not.toContain('data-state="done"')
  })

  it.each([
    { phase: 'failed', state: 'error' },
    { phase: 'declined', state: 'warning' },
  ] as const)('keeps the $state status dot for $phase trajectory', ({ phase, state }) => {
    const action = codexActionView({ ...lifecycleBlock(), phase })
    const html = renderToStaticMarkup(<CodexActionRow active={false} action={action!} t={t} />)
    expect(html).toContain(`data-state="${state}"`)
  })

  it('settles a requested action when its matching outcome is already present', () => {
    const requested = {
      ...lifecycleBlock(),
      actionId: 'native-call-1',
      actionType: 'custom_tool_call',
      category: 'action',
      phase: 'requested',
    } satisfies CodexActionBlock
    const completed = {
      ...lifecycleBlock(),
      actionId: 'native-call-1',
      actionType: 'custom_tool_call_output',
      category: 'action',
      phase: 'completed',
    } satisfies CodexActionBlock
    const html = renderToStaticMarkup(
      <CodexAssistantBody
        blocks={[
          { kind: 'other', block: requested },
          { kind: 'other', block: completed },
        ]}
        streaming
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    expect(html).not.toContain('data-state="ongoing"')
    expect(html).not.toContain('data-state="done"')
  })

  it('specializes codex-action while preserving the generic fallback', () => {
    const actionOnly: readonly AssistantBlock[] = [{ kind: 'other', block: lifecycleBlock() }]
    const actionHtml = renderToStaticMarkup(
      <CodexAssistantBody
        blocks={actionOnly}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    expect(actionHtml).toContain('data-codex-assistant-renderer="true"')
    expect(actionHtml).toContain('Codex 生命周期')
    expect(actionHtml).not.toContain('未知内容块')

    const generic: readonly AssistantBlock[] = [{ kind: 'other', block: { type: 'future-block' } }]
    const genericHtml = renderToStaticMarkup(
      <CodexAssistantBody
        blocks={generic}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    expect(genericHtml).toContain('未知内容块')
  })

  it('routes consecutive images through the attachment presentation slot', () => {
    const first = {
      attachmentId: AttachmentId('sha256:first'),
      mediaType: 'image/png' as const,
      bytes: 1,
      width: 1,
      height: 1,
      name: 'first.png',
    }
    const second = {
      attachmentId: AttachmentId('sha256:second'),
      mediaType: 'image/jpeg' as const,
      bytes: 2,
      width: 2,
      height: 1,
      name: 'second.jpg',
    }
    const renderImages = vi.fn(() => <span data-image-slot />)
    const blocks: readonly AssistantBlock[] = [
      { kind: 'image', attachment: first },
      { kind: 'image', attachment: second },
    ]

    const html = renderToStaticMarkup(
      <CodexAssistantBody
        blocks={blocks}
        streaming={false}
        renderMessageImages={renderImages}
        t={t}
      />,
    )

    expect(renderImages).toHaveBeenCalledOnce()
    expect(renderImages).toHaveBeenCalledWith({
      images: [{ attachment: first }, { attachment: second }],
      align: 'start',
    })
    expect(html).toContain('data-image-slot')
  })

  it('renders earlier records without inventing a missing protocol event', () => {
    const { category: _category, protocolEvent: _protocolEvent, ...legacy } = lifecycleBlock()
    expect(isCodexActionBlock(legacy)).toBe(false)
    expect(codexActionView(legacy)).toMatchObject({
      category: 'lifecycle',
      protocolEvent: undefined,
      legacy: true,
    })

    const action = codexActionView(legacy)
    const blocks: readonly AssistantBlock[] = [{ kind: 'other', block: legacy }]
    const html = renderToStaticMarkup(
      <CodexAssistantBody
        blocks={blocks}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    expect(html).toContain('data-codex-action="thread/start"')
    expect(html).not.toContain('未知内容块')

    const detailsHtml = renderToStaticMarkup(<CodexActionDetails action={action!} t={t} />)
    expect(detailsHtml).toContain('旧版记录未写入')
    expect(detailsHtml).toContain('当时尚未写入 category 与 protocolEvent')
  })

  it('shadows the stock assistant cell without replacing its slot declaration', () => {
    const register = vi.fn(() => () => {})
    const localeRegister = vi.fn(() => () => {})
    const settingsScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        value: {},
        base: {},
        user: {},
        revision: 0,
        writable: true,
        mode: 'host' as const,
      }),
      subscribe: () => () => {},
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    }
    const ctx = {
      effect(factory: () => () => void) {
        factory()
      },
      locale: { register: localeRegister },
      settingsScope: { bind: vi.fn(() => settingsScope) },
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
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'settings.plugin.item',
      key: 'llm-codex-app-server',
      locale: NS,
    }), expect.any(Function))
  })
})
