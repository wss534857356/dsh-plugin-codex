import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerEvent, CodexAppServerRequest, CodexAppServerRunnerPort } from '../src/runner.ts'
import { CodexWebSearchProvider } from '../src/web-search.ts'

function completed(): CodexAppServerEvent {
  return {
    kind: 'notification',
    method: 'turn/completed',
    params: {
      threadId: 'thread-search',
      turn: { id: 'turn-search', status: 'completed', error: null },
    },
  }
}

function runner(events: readonly CodexAppServerEvent[]): {
  readonly runner: CodexAppServerRunnerPort
  readonly stream: ReturnType<typeof vi.fn<(request: CodexAppServerRequest) => AsyncIterable<CodexAppServerEvent>>>
} {
  const stream = vi.fn((request: CodexAppServerRequest): AsyncIterable<CodexAppServerEvent> => {
    void request
    return (async function * () {
      for (const event of events) yield event
    })()
  })
  return {
    stream,
    runner: {
      open: vi.fn(async () => { throw new Error('stateful thread was not expected') }),
      stream,
    },
  }
}

describe('CodexWebSearchProvider', () => {
  it('uses the initiating Codex model and maps native URL citations', async () => {
    const answer = 'The App Server protocol is documented by OpenAI.'
    const setup = runner([
      {
        kind: 'notification',
        method: 'item/completed',
        params: {
          threadId: 'thread-search',
          turnId: 'turn-search',
          item: {
            type: 'webSearch',
            id: 'search-1',
            query: 'Codex App Server',
            action: { type: 'search', query: 'Codex App Server' },
          },
        },
      },
      {
        kind: 'notification',
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-search',
          turnId: 'turn-search',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{
              type: 'output_text',
              text: answer,
              annotations: [{
                type: 'url_citation',
                url: 'https://developers.openai.com/codex/app-server/',
                title: 'Codex App Server',
              }],
            }],
          },
        },
      },
      {
        kind: 'notification',
        method: 'item/completed',
        params: {
          threadId: 'thread-search',
          turnId: 'turn-search',
          item: { type: 'agentMessage', id: 'answer-1', text: answer },
        },
      },
      completed(),
    ])
    const provider = new CodexWebSearchProvider({
      modelProvider: 'openai',
      runner: setup.runner,
    })

    await expect(provider.search(
      { provider: 'codex-local', model: 'gpt-5.6-sol' },
      { query: 'Codex App Server', maxResults: 4 },
    )).resolves.toEqual({
      content: answer,
      sources: [{
        url: 'https://developers.openai.com/codex/app-server/',
        title: 'Codex App Server',
      }],
      truncated: false,
    })
    expect(setup.stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      dynamicTools: [],
      webSearch: 'live',
      imageGenerationEnabled: false,
    }))
  })

  it('rejects a missing main-model target before process startup', async () => {
    const setup = runner([])
    const provider = new CodexWebSearchProvider({
      modelProvider: 'openai',
      runner: setup.runner,
    })

    await expect(provider.search(
      { provider: 'codex-local', model: '' },
      { query: 'query' },
    )).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
    })
    expect(setup.stream).not.toHaveBeenCalled()
  })

  it('fails closed when Codex does not return citeable search sources', async () => {
    const setup = runner([
      {
        kind: 'notification',
        method: 'item/completed',
        params: {
          threadId: 'thread-search',
          turnId: 'turn-search',
          item: { type: 'webSearch', id: 'search-1', query: 'query' },
        },
      },
      {
        kind: 'notification',
        method: 'item/completed',
        params: {
          threadId: 'thread-search',
          turnId: 'turn-search',
          item: { type: 'agentMessage', id: 'answer-1', text: 'uncited answer' },
        },
      },
      completed(),
    ])
    const provider = new CodexWebSearchProvider({
      modelProvider: 'openai',
      runner: setup.runner,
    })

    await expect(provider.search(
      { provider: 'codex-local', model: 'gpt-5.6-sol' },
      { query: 'query' },
    )).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
    })
  })
})
