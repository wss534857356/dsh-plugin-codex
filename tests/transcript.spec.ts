import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  BlockAssembler,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  Message,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { CodexAppServerAdapter } from '../src/adapter.ts'
import type {
  CodexAppServerEvent,
  CodexAppServerRequest,
  CodexAppServerRunnerPort,
} from '../src/runner.ts'

const PROVIDER = 'codex-local'
const MODEL = 'gpt-5.6-sol'

const tool: ToolSchema = {
  name: 'read_file',
  description: 'Read one file.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function completedTurn(): CodexAppServerEvent {
  return {
    kind: 'notification',
    method: 'turn/completed',
    params: {
      threadId: 'thread-2',
      turn: { id: 'turn-2', status: 'completed', error: null },
    },
  }
}

class TranscriptRunner implements CodexAppServerRunnerPort {
  readonly requests: CodexAppServerRequest[] = []

  async open(): Promise<never> {
    throw new Error('stateful runner was not expected')
  }

  async * stream(request: CodexAppServerRequest): AsyncIterable<CodexAppServerEvent> {
    this.requests.push(request)
    if (this.requests.length === 1) {
      yield {
        kind: 'thread-started',
        threadId: 'thread-1',
        userAgent: 'deepseek-harness/0.147.0',
        instructionSources: [{ path: 'C:/Users/demo/.codex/AGENTS.md' }],
      }
      yield {
        kind: 'notification',
        method: 'item/reasoning/summaryTextDelta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'reasoning-1',
          summaryIndex: 0,
          delta: 'Need the logged file result.',
        },
      }
      yield {
        kind: 'notification',
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'reasoning',
            id: 'reasoning-1',
            summary: ['Need the logged file result.'],
            content: [],
          },
        },
      }
      yield {
        kind: 'notification',
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'commandExecution',
            id: 'native-command-1',
            command: 'pwd',
            status: 'inProgress',
          },
        },
      }
      yield {
        kind: 'notification',
        method: 'item/commandExecution/outputDelta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'native-command-1',
          delta: 'C:/private-workdir',
        },
      }
      yield {
        kind: 'notification',
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'commandExecution',
            id: 'native-command-1',
            command: 'pwd',
            status: 'completed',
            aggregatedOutput: 'C:/private-workdir',
            exitCode: 0,
          },
        },
      }
      yield {
        kind: 'server-request',
        id: 'rpc-tool-1',
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-read-1',
          namespace: null,
          tool: 'read_file',
          arguments: { path: 'notes.txt' },
        },
        resolution: 'rejected',
      }
      return
    }
    yield {
      kind: 'thread-started',
      threadId: 'thread-2',
      userAgent: 'deepseek-harness/0.147.0',
      instructionSources: [],
    }
    yield {
      kind: 'notification',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-2',
        turnId: 'turn-2',
        itemId: 'message-2',
        delta: 'The file says hello.',
      },
    }
    yield {
      kind: 'notification',
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-2',
        turnId: 'turn-2',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The file says hello.' }],
        },
      },
    }
    yield {
      kind: 'notification',
      method: 'item/completed',
      params: {
        threadId: 'thread-2',
        turnId: 'turn-2',
        item: { type: 'agentMessage', id: 'message-2', text: 'The file says hello.' },
      },
    }
    yield completedTurn()
  }
}

async function assemble(
  ctx: Context,
  messages: Message[],
): Promise<{ readonly message: Message; readonly finish: FinishReason }> {
  const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL })
  const assembler = new BlockAssembler()
  const request: GenerateOptions = {
    ...prepared.config,
    system: 'Use Harness tools for project data.',
    messages,
    tools: [tool],
  }
  for await (const chunk of prepared.stream(request)) assembler.push(chunk)
  return {
    message: assembler.message({
      kind: 'model',
      provider: PROVIDER,
      model: MODEL,
      replayState: assembler.replayState,
    }),
    finish: assembler.finish,
  }
}

describe('assembled Harness transcript', () => {
  it('keeps Codex actions distinct from Harness tool calls across a tool round trip', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const runner = new TranscriptRunner()
    ctx.llm.registerAdapter([PROVIDER], new CodexAppServerAdapter({
      provider: PROVIDER,
      displayName: 'Codex local',
      modelProvider: 'openai',
      models: [{ id: MODEL, name: 'GPT-5.6 Sol', reasoningEfforts: ['low'] }],
      maxRetries: 0,
      runner,
    }))

    const user = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Read notes.txt.' }],
    })
    const first = await assemble(ctx, [user])
    const call = first.message.content.find(
      (block): block is Extract<Message['content'][number], { type: 'tool-call' }> => block.type === 'tool-call',
    )
    if (call === undefined) throw new Error('snapshot fixture emitted no Harness tool call')
    const result = createToolResultMessage({
      callId: call.id,
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    })
    const second = await assemble(ctx, [user, first.message, result])

    expect({
      first: { finish: first.finish, content: first.message.content },
      secondRequestHistory: runner.requests[1]?.history,
      second: { finish: second.finish, content: second.message.content },
    }).toMatchSnapshot()
  })
})
