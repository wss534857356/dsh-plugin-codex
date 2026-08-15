/** Real local-login smoke for the assembled Harness LLM and subprocess services. */

import { afterEach, describe, expect, it, vi } from 'vitest'
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
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as CodexAppServer from '../src/index.ts'

const PROVIDER = 'codex-local'
const MODEL = 'gpt-5.6-sol'
const ARGUMENT_SENTINEL = 'CODEX_HARNESS_TOOL_OK'
const RESPONSE_SENTINEL = 'CODEX_HARNESS_ROUNDTRIP_OK'
const CACHE_SENTINEL = 'CODEX_HARNESS_CACHE_OK'
const SESSION_ID = SessionId('real-codex-cache-session')
const SYSTEM = 'Follow the user request exactly. When echo_sentinel is explicitly requested, call it once and answer with its result only. Never call it otherwise.'

const tool: ToolSchema = {
  name: 'echo_sentinel',
  description: 'Return the supplied smoke-test sentinel unchanged.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      value: { type: 'string', const: ARGUMENT_SENTINEL },
    },
    required: ['value'],
  },
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function assemble(
  ctx: Context,
  messages: Message[],
): Promise<{ readonly message: Message; readonly finish: FinishReason; readonly usage?: TokenUsage }> {
  const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL })
  const assembler = new BlockAssembler()
  const request: GenerateOptions = {
    ...prepared.config,
    system: SYSTEM,
    messages,
    tools: [tool],
    sessionId: SESSION_ID,
  }
  for await (const chunk of prepared.stream(request)) assembler.push(chunk)
  const finish = finishOf(assembler.finish)
  return {
    message: assembler.message({
      kind: 'model',
      provider: PROVIDER,
      model: MODEL,
      replayState: assembler.replayState,
    }),
    finish,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

function finishOf(finish: FinishReason): FinishReason {
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`Codex smoke failed: ${JSON.stringify(finish)}`)
  }
  return finish
}

function toolCall(message: Message): Extract<Message['content'][number], { type: 'tool-call' }> {
  const calls = message.content.filter(
    (block): block is Extract<Message['content'][number], { type: 'tool-call' }> => block.type === 'tool-call',
  )
  expect(calls).toHaveLength(1)
  return calls[0]!
}

function responseText(message: Message): string {
  return message.content
    .filter((block): block is Extract<Message['content'][number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('real locally authenticated Codex bridge', () => {
  it('reuses one thread, reports a provider cache hit, and leaves no process tree behind', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalSubprocessRuntime)

    const handles: SubprocessHandle[] = []
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn(spec)
      handles.push(handle)
      return handle
    })
    await ctx.plugin(CodexAppServer, { timeoutMs: 600_000, disposeGraceMs: 3_000 })

    expect(ctx.llm.listProviders()).toContainEqual({ id: PROVIDER, name: 'Codex (local login)' })

    const user = createUserMessage({
      source: { kind: 'user' },
      content: [{
        type: 'text',
        text: `Request echo_sentinel with value ${ARGUMENT_SENTINEL}. Do not answer directly.`,
      }],
    })
    const first = await assemble(ctx, [user])
    expect(first.finish, JSON.stringify(first.message.content, null, 2)).toEqual({ kind: 'tool-calls' })
    expect(first.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'codex-action', actionType: 'thread/start' }),
      expect.objectContaining({
        type: 'codex-action',
        actionType: 'context/injected',
        category: 'context',
      }),
      expect.objectContaining({
        type: 'codex-action',
        actionType: 'custom_tool_call',
        category: 'action',
        phase: 'requested',
      }),
    ]))
    expect(first.message.source).toMatchObject({
      kind: 'model',
      replayState: { kind: 'codex-app-server', version: 2 },
    })
    const call = toolCall(first.message)
    expect(call.name).toBe(tool.name)
    expect(JSON.parse(call.arguments)).toEqual({ value: ARGUMENT_SENTINEL })

    const result = createToolResultMessage({
      callId: call.id,
      content: [{ type: 'text', text: RESPONSE_SENTINEL }],
      isError: false,
    })
    const second = await assemble(ctx, [user, first.message, result])
    expect(second.finish).toEqual({ kind: 'stop' })
    expect(responseText(second.message).trim()).toBe(RESPONSE_SENTINEL)

    const followUp = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: `Reply with exactly ${CACHE_SENTINEL}. Do not use a tool.` }],
    })
    const third = await assemble(ctx, [user, first.message, result, second.message, followUp])
    expect(third.finish).toEqual({ kind: 'stop' })
    expect(responseText(third.message).trim()).toBe(CACHE_SENTINEL)
    const cacheEvidence = {
      handles: handles.length,
      firstUsage: first.usage,
      secondUsage: second.usage,
      thirdUsage: third.usage,
      thirdActions: third.message.content.flatMap(block => block.type === 'codex-action'
        ? [{ type: block.actionType, event: block.protocolEvent }]
        : []),
    }
    expect(third.usage?.cacheReadTokens ?? 0, JSON.stringify(cacheEvidence, null, 2)).toBeGreaterThan(0)

    expect(handles).toHaveLength(1)
    await ctx.fiber.dispose()
    const contextIndex = contexts.indexOf(ctx)
    if (contextIndex >= 0) contexts.splice(contextIndex, 1)
    for (const handle of handles) await expect(handle.waitForExit()).resolves.toBe(true)
  })
})
