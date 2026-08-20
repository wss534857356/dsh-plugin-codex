import { Fragment, memo, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DisclosureRow,
  IconApiOutline14,
  IconBrowseOutline16,
  IconListPenOutline16,
  IconQuestionOutline14,
  JsonBlock,
  JsonTree,
  MarkdownText,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RenderMessageImages, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CodexActionBlock } from '../protocol.ts'
import { NS } from './locales.ts'
import css from './CodexAssistantNodeView.module.css'

type CodexTranslate = TranslateNS<typeof NS>
type CodexActionCategory = CodexActionBlock['category'] | 'legacy'

/** Validated presentation fields over current and earlier durable records. */
export interface CodexActionView {
  readonly raw: Readonly<Record<string, unknown>>
  readonly actionId: string
  readonly actionType: string
  readonly category: CodexActionCategory
  readonly phase: CodexActionBlock['phase']
  readonly protocolEvent: string | undefined
  readonly snapshot: unknown
  readonly legacy: boolean
}

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

/** Decode a current record or the earlier format that omitted two presentation fields. */
export function codexActionView(value: unknown): CodexActionView | undefined {
  const candidate = record(value)
  if (candidate?.type !== 'codex-action'
    || typeof candidate.actionId !== 'string'
    || typeof candidate.actionType !== 'string'
    || typeof candidate.phase !== 'string'
    || !PHASES.has(candidate.phase as CodexActionBlock['phase'])
    || !Object.hasOwn(candidate, 'snapshot')) return undefined

  if (isCodexActionBlock(candidate)) {
    return {
      raw: candidate,
      actionId: candidate.actionId,
      actionType: candidate.actionType,
      category: candidate.category,
      phase: candidate.phase,
      protocolEvent: candidate.protocolEvent,
      snapshot: candidate.snapshot,
      legacy: false,
    }
  }
  if (candidate.category !== undefined || candidate.protocolEvent !== undefined) return undefined
  const category: CodexActionCategory = candidate.actionType === 'thread/start'
    ? 'lifecycle'
    : candidate.actionType === 'context/injected' ? 'context' : 'legacy'
  return {
    raw: candidate,
    actionId: candidate.actionId,
    actionType: candidate.actionType,
    category,
    phase: candidate.phase as CodexActionBlock['phase'],
    protocolEvent: undefined,
    snapshot: candidate.snapshot,
    legacy: true,
  }
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

function settledActionIcon(action: CodexActionView): ReactNode {
  if (action.category === 'context') return <IconBrowseOutline16 size={14} />
  switch (action.actionType) {
    case 'turn/plan/updated': return <IconListPenOutline16 size={14} />
    case 'item/tool/requestUserInput': return <IconQuestionOutline14 size={14} />
    default: return <IconApiOutline14 size={14} />
  }
}

function actionIcon(action: CodexActionView, active: boolean): ReactNode {
  switch (action.phase) {
    case 'requested':
    case 'started': return active ? <StateDot state="ongoing" /> : settledActionIcon(action)
    case 'updated':
    case 'completed': return settledActionIcon(action)
    case 'failed': return <StateDot state="error" />
    case 'declined': return <StateDot state="warning" />
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) return value.join(' ')
  return undefined
}

/** Produce a concise interpretation while retaining the complete record below it. */
export function actionSummary(block: CodexActionView, t: CodexTranslate): string | undefined {
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

/** Expanded inspection content for a Codex-native trajectory row. */
export function CodexActionDetails({ action, t }: { action: CodexActionView; t: CodexTranslate }) {
  const summary = actionSummary(action, t)
  return (
    <div className={css.actionBody}>
      {summary !== undefined && <p className={css.actionSummary}>{summary}</p>}
      {action.legacy && <p className={css.legacy}>{t('action.legacy')}</p>}
      <dl className={css.metadata}>
        <div>
          <dt>{t('action.protocolEvent')}</dt>
          <dd><code>{action.protocolEvent ?? t('action.protocolUnavailable')}</code></dd>
        </div>
        <div>
          <dt>{t('action.id')}</dt>
          <dd><code>{action.actionId}</code></dd>
        </div>
      </dl>
      <JsonTree className={css.actionJson} data={action.raw} label={t('action.details')} />
    </div>
  )
}

/** Harness-native compact row for one truthful Codex-native trajectory record. */
export function CodexActionRow({
  active,
  action,
  t,
}: {
  active: boolean
  action: CodexActionView
  t: CodexTranslate
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      className={css.actionRow}
      data-codex-action={action.actionType}
      data-category={action.category}
      data-phase={action.phase}
      data-legacy={action.legacy || undefined}
    >
      <DisclosureRow
        rowClassName={css.actionHeader}
        titleClassName={css.actionTitle}
        icon={actionIcon(action, active)}
        title={actionTitle(action.actionType, t)}
        open={expanded}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.actionSeparator} aria-hidden />
            <span className={css.actionCategory}>{t(`action.category.${action.category}`)}</span>
            <span className={css.actionPhase}>{t(`action.phase.${action.phase}`)}</span>
          </>
        )}
      >
        <CodexActionDetails action={action} t={t} />
      </DisclosureRow>
    </div>
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

export interface CodexAssistantBodyProps {
  readonly blocks: readonly AssistantBlock[]
  readonly streaming: boolean
  readonly interrupted?: boolean | undefined
  readonly renderMessageImages: RenderMessageImages
  readonly mentions?: MarkdownFileMentions | undefined
  readonly t: CodexTranslate
}

/** Preserve the stock Assistant block behaviors and specialize only `codex-action`. */
export const CodexAssistantBody = memo(function CodexAssistantBody({
  blocks,
  streaming,
  interrupted,
  renderMessageImages,
  mentions,
  t,
}: CodexAssistantBodyProps) {
  const codeLabels = useMemo(() => ({ copyLabel: t('copy'), copiedLabel: t('copied') }), [t])
  const last = blocks.length - 1
  const hasVisible = streaming
    || interrupted === true
    || blocks.some(block => block.kind !== 'tool-call')
  if (!hasVisible) return null

  const settledActionIds = new Set<string>()
  for (const block of blocks) {
    if (block.kind !== 'other') continue
    const action = codexActionView(block.block)
    if (action === undefined) continue
    if (action.phase === 'completed' || action.phase === 'failed' || action.phase === 'declined') {
      settledActionIds.add(action.actionId)
    }
  }

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
        rendered.push(
          <Fragment key={start}>
            {renderMessageImages({
              images: group.map(({ attachment }) => ({ attachment })),
              align: 'start',
            })}
          </Fragment>,
        )
        break
      }
      case 'tool-call':
        break
      case 'other': {
        const action = codexActionView(block.block)
        rendered.push(action !== undefined
          ? (
              <CodexActionRow
                key={index}
                active={streaming && !settledActionIds.has(action.actionId)}
                action={action}
                t={t}
              />
            )
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
  renderMessageImages,
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
      renderMessageImages={renderMessageImages}
      mentions={mentions}
      t={t}
    />
  )
})
