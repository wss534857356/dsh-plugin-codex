/** Codex-native web search projected into the Harness web capability. */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type {
  CodexAppServerEvent,
  CodexAppServerRunnerPort,
  JsonValue,
} from './runner.ts'

/** Main-model route inherited by one auxiliary search. */
export interface CodexSearchTarget {
  readonly provider: string
  readonly model: string
}

/** Construction values for {@link CodexWebSearchProvider}. */
export interface CodexWebSearchProviderOptions {
  readonly modelProvider: string
  readonly runner: CodexAppServerRunnerPort
}

const SEARCH_SYSTEM = [
  'You are a web-search backend for another coding agent.',
  'Use native live web search for the supplied query.',
  'Return a concise evidence-grounded answer with inline URL citations.',
  'Do not perform unrelated work.',
].join(' ')

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:' ? value : undefined
}

function addSource(
  sources: Map<string, WebSearchSource>,
  urlValue: unknown,
  titleValue?: unknown,
): void {
  const url = httpUrl(urlValue)
  if (url === undefined || sources.has(url)) return
  const title = typeof titleValue === 'string' && titleValue.length > 0 ? titleValue : undefined
  sources.set(url, { url, ...(title === undefined ? {} : { title }) })
}

/** Collect URL-bearing citation/source objects without interpreting provider prose. */
function collectSources(value: unknown, sources: Map<string, WebSearchSource>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSources(item, sources)
    return
  }
  const candidate = object(value)
  if (candidate === undefined) return
  const type = candidate.type
  if (type === 'url_citation' || type === 'web_search_result' || type === 'source') {
    addSource(sources, candidate.url, candidate.title)
  }
  for (const nested of Object.values(candidate)) collectSources(nested, sources)
}

function collectMarkdownSources(text: string, sources: Map<string, WebSearchSource>): void {
  const links = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu
  for (const match of text.matchAll(links)) addSource(sources, match[2], match[1])
}

function rawAssistantText(item: Record<string, unknown>): string | undefined {
  if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) return undefined
  const text = item.content.flatMap((value) => {
    const block = object(value)
    return block?.type === 'output_text' && typeof block.text === 'string' ? [block.text] : []
  }).join('')
  return text.length > 0 ? text : undefined
}

function completedTurnError(event: CodexAppServerEvent): Error | undefined {
  if (event.kind !== 'notification' || event.method !== 'turn/completed') return undefined
  const turn = object(event.params.turn)
  if (turn?.status === 'completed') return undefined
  const failure = object(turn?.error)
  const message = typeof failure?.message === 'string'
    ? failure.message
    : `Codex web-search turn ended with status ${String(turn?.status)}`
  return new Error(message)
}

function searchAborted(signal: AbortSignal | undefined, cause?: unknown): WebError {
  return new WebError('Codex web search was aborted', 'WEB_ABORTED', { cause: cause ?? signal?.reason })
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** One-shot Codex App Server search using an explicitly resolved main-model target. */
export class CodexWebSearchProvider {
  constructor(private readonly options: CodexWebSearchProviderOptions) {}

  async search(
    target: CodexSearchTarget,
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    if (isAborted(signal)) throw searchAborted(signal)
    if (target.model.length === 0) throw new WebError('Codex web search requires a model', 'WEB_PROVIDER_ERROR')

    const sources = new Map<string, WebSearchSource>()
    let answer = ''
    let searched = false
    const history: JsonValue[] = [{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: `Search the web for this query and answer with cited sources:\n\n${request.query}`,
      }],
    }]

    try {
      for await (const event of this.options.runner.stream({
        model: target.model,
        modelProvider: this.options.modelProvider,
        system: SEARCH_SYSTEM,
        history,
        dynamicTools: [],
        webSearch: 'live',
        // The search process has one job and must not branch into image work.
        imageGenerationEnabled: false,
        ...(signal === undefined ? {} : { signal }),
      })) {
        if (event.kind !== 'notification') continue
        if (event.method === 'item/started' || event.method === 'item/completed') {
          const item = object(event.params.item)
          if (item?.type === 'webSearch') {
            searched = true
            collectSources(item, sources)
          }
          if (event.method === 'item/completed'
            && item?.type === 'agentMessage'
            && typeof item.text === 'string') answer = item.text
        } else if (event.method === 'rawResponseItem/completed') {
          const item = object(event.params.item)
          if (item?.type === 'web_search_call') searched = true
          collectSources(item, sources)
          const text = item === undefined ? undefined : rawAssistantText(item)
          if (text !== undefined) answer = text
        }
        const failure = completedTurnError(event)
        if (failure !== undefined) throw failure
      }
    } catch (error: unknown) {
      if (isAborted(signal)) throw searchAborted(signal, error)
      if (error instanceof WebError) throw error
      throw new WebError(`Codex web search failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    collectMarkdownSources(answer, sources)
    if (!searched) {
      throw new WebError('Codex completed without invoking native web search', 'WEB_PROVIDER_ERROR')
    }
    if (sources.size === 0) {
      throw new WebError('Codex web search returned no citeable sources', 'WEB_PROVIDER_ERROR')
    }
    return {
      ...(answer.length === 0 ? {} : { content: answer }),
      sources: [...sources.values()],
      truncated: false,
    }
  }
}
