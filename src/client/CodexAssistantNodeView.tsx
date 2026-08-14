import { memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { ImageGallery } from '@deepseek-ai/dsh-client-ui-attachment'
import type { ImageLoader, MessageImageLabels } from '@deepseek-ai/dsh-client-ui-attachment'
import { JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CodexActionBlock } from '../protocol.ts'
import { NS } from './locales.ts'
import css from './CodexAssistantNodeView.module.css'

type CodexTranslate = TranslateNS<typeof NS>

const CATEGORIES = new Set<CodexActionBlock['category']>([
  'lifecycle',
  'context',
  'action',
  'diagnostic',
])

const PHASES = new Set<CodexActionBlock['phase']>([
  'requested',
  'started',
  'updated',
  'completed',
  'failed',
  'declined',
])

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

/** Test whether an opaque Assistant block is this provider's durable trajectory record. */
export function isCodexActionBlock(value: unknown): value is CodexActionBlock {
  const candidate = record(value)
  return candidate?.type === 'codex-action'
    && typeof candidate.actionId === 'string'
    && typeof candidate.actionType === 'string'
    && typeof candidate.protocolEvent === 'string'
    && typeof candidate.category === 'string'
    && CATEGORIES.has(candidate.category as CodexActionBlock['category'])
    && typeof candidate.phase === 'string'
    && PHASES.has(candidate.phase as CodexActionBlock['phase'])
    && Object.hasOwn(candidate, 'snapshot')
}

function actionTitle(actionType: string, t: CodexTranslate): string {
  switch (actionType) {
    case 'thread/start': return t('action.type.threadStart')
    case 'context/injected': return t('action.type.contextInjected')
    case 'commandExecution': return t('action.type.commandExecution')
    case 'item/commandExecution/outputDelta': return t('action.type.commandOutput')
    case 'custom_tool_call': return t('action.type.customToolCall')
    case 'custom_tool_call_output': return t('action.type.customToolOutput')
    case 'turn/plan/updated': return t('action.type.planUpdated')
    default: return actionType
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) return value.join(' ')
  return undefined
}

/** Produce a concise interpretation while retaining the complete record below it. */
export function actionSummary(block: CodexActionBlock, t: CodexTranslate): string | undefined {
  const snapshot = record(block.snapshot)
  if (block.actionType === 'thread/start') {
    const sources = snapshot?.instructionSources
    return t('action.summary.threadStart', { count: Array.isArray(sources) ? sources.length : 0 })
  }
  if (block.actionType === 'context/injected') {
    const kind = stringValue(snapshot?.type) ?? stringValue(snapshot?.role) ?? 'provider'
    return t('action.summary.context', { kind })
  }
  const command = stringValue(snapshot?.command)
  if (command !== undefined) return t('action.summary.command', { command })
  const status = stringValue(snapshot?.status)
  if (status !== undefined) return t('action.summary.status', { status })
  return undefined
}

/** Dedicated presentation for one truthful Codex-native trajectory record. */
export function CodexActionCard({ block, t }: { block: CodexActionBlock; t: CodexTranslate }) {
  const summary = actionSummary(block, t)
  return (
    <section
      className={css.action}
      data-codex-action={block.actionType}
      data-category={block.category}
      data-phase={block.phase}
    >
      <header className={css.actionHeader}>
        <span className={css.category}>{t(`action.category.${block.category}`)}</span>
        <strong className={css.actionTitle}>{actionTitle(block.actionType, t)}</strong>
        <span className={css.phase}>{t(`action.phase.${block.phase}`)}</span>
      </header>
      <code className={css.actionType}>{block.actionType}</code>
      {summary !== undefined && <p className={css.actionSummary}>{summary}</p>}
      <dl className={css.metadata}>
        <div>
          <dt>{t('action.protocolEvent')}</dt>
          <dd><code>{block.protocolEvent}</code></dd>
        </div>
        <div>
          <dt>{t('action.id')}</dt>
          <dd><code>{block.actionId}</code></dd>
        </div>
      </dl>
      <JsonBlock
        label={t('action.details')}
        payload={block}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    </section>
  )
}

function firstLine(text: string): string {
  const visible = text.trim()
  const newline = visible.indexOf('\n')
  return newline < 0 ? visible : visible.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline < 0 ? visible : visible.slice(newline + 1)
}

function ReasoningBlock({ text, running, t }: { text: string; running: boolean; t: CodexTranslate }) {
  const summary = running ? latestLine(text) : firstLine(text)
  return (
    <details className={css.reasoning} data-running={running || undefined}>
      <summary>
        <span>{t('reasoning.title')}</span>
        {summary !== '' && <span className={css.reasoningSummary}>{summary}</span>}
        {running && <span className={css.reasoningState}>{t('reasoning.running')}</span>}
      </summary>
      <div className={css.reasoningBody}>{text}</div>
    </details>
  )
}

function imageLabels(t: CodexTranslate): MessageImageLabels {
  return {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: label => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: {
      dialog: t('image.preview'),
      close: t('image.closePreview'),
    },
  }
}

export interface CodexAssistantBodyProps {
  readonly blocks: readonly AssistantBlock[]
  readonly streaming: boolean
  readonly interrupted?: boolean | undefined
  readonly loadImage?: ImageLoader | undefined
  readonly mentions?: MarkdownFileMentions | undefined
  readonly t: CodexTranslate
}

/** Preserve the stock Assistant block behaviors and specialize only `codex-action`. */
export const CodexAssistantBody = memo(function CodexAssistantBody({
  blocks,
  streaming,
  interrupted,
  loadImage,
  mentions,
  t,
}: CodexAssistantBodyProps) {
  const codeLabels = useMemo(() => ({ copyLabel: t('copy'), copiedLabel: t('copied') }), [t])
  const labels = useMemo(() => imageLabels(t), [t])
  const loader = loadImage ?? (() => Promise.reject(new Error(t('image.loadFailed'))))
  const last = blocks.length - 1
  const hasVisible = streaming
    || interrupted === true
    || blocks.some(block => block.kind !== 'tool-call')
  if (!hasVisible) return null

  const rendered: ReactNode[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block === undefined) continue
    switch (block.kind) {
      case 'text':
        rendered.push(
          <MarkdownText
            key={index}
            text={block.text}
            streaming={streaming}
            codeLabels={codeLabels}
            fileMentions={mentions}
          />,
        )
        break
      case 'reasoning':
        rendered.push(<ReasoningBlock key={index} text={block.text} running={streaming && index === last} t={t} />)
        break
      case 'image': {
        const start = index
        const group = [block]
        while (index + 1 < blocks.length) {
          const next = blocks[index + 1]
          if (next === undefined || next.kind !== 'image') break
          group.push(next)
          index += 1
        }
        rendered.push(<ImageGallery key={start} images={group} load={loader} align="start" labels={labels} />)
        break
      }
      case 'tool-call':
        break
      case 'other':
        rendered.push(isCodexActionBlock(block.block)
          ? <CodexActionCard key={index} block={block.block} t={t} />
          : (
            <JsonBlock
              key={index}
              label={t('message.unknownBlock')}
              payload={block.block}
              truncatedLabel={total => t('json.truncated', { total })}
            />
            ))
        break
    }
  }

  return (
    <div className={css.root} data-codex-assistant-renderer data-streaming={streaming || undefined}>
      <div className={css.body}>
        {rendered}
        {interrupted === true && <span className={css.stopped}>{t('message.stopped')}</span>}
      </div>
    </div>
  )
})

type CodexAssistantNodeViewProps =
  PropsRuntime<'conversation.chat.node', 'assistant-step'> & PropsLocale<typeof NS>

/** Assistant renderer shadow that keeps Harness content and recognizes Codex trajectory blocks. */
export const CodexAssistantNodeView = memo(function CodexAssistantNodeView({
  node,
  useTurnData,
  openFile,
  loadImage,
  fileMentions,
  t,
}: CodexAssistantNodeViewProps) {
  const data = node.data
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const tail = useTurnData('turn-tail')
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== 'closed' || data.finalNode === undefined) return undefined
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined
    return { turn, seq: data.finalNode.seq, openFile }
  }, [data.finalNode, openFile, tail, turn])
  const mentions = useMemo(
    () => owner === undefined ? undefined : fileMentions(owner),
    [fileMentions, owner],
  )
  return (
    <CodexAssistantBody
      blocks={data.blocks}
      streaming={data.status === 'running'}
      interrupted={data.status === 'interrupted'}
      loadImage={loadImage}
      mentions={mentions}
      t={t}
    />
  )
})
