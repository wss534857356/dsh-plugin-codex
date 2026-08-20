/** Real local-login smoke for the assembled Harness LLM and subprocess services. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
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
const IMAGE_SENTINEL = 'CODEX_HARNESS_IMAGE_OK'
const IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const IMAGE_DATA = Buffer.from(IMAGE_BASE64, 'base64')
const IMAGE_REF = {
  attachmentId: AttachmentId('sha256:real-image-input'),
  mediaType: 'image/png' as const,
  bytes: IMAGE_DATA.byteLength,
  width: 1,
  height: 1,
  name: 'pixel.png',
}
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
  it('reuses one thread, accepts durable image input, and leaves no process tree behind', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const readImage = vi.fn(async (ref: typeof IMAGE_REF) => ({ ref, data: IMAGE_DATA }))
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 5 * 1024 * 1024,
        maxImagesPerMessage: 8,
        maxMessageImageBytes: 20 * 1024 * 1024,
        maxImagePixels: 20_000_000,
        maxImageDimension: 2_000,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      validateImage: vi.fn(async () => {}),
      saveImage: vi.fn(async () => IMAGE_REF),
      readImage,
    } as never)

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
      replayState: { response: { kind: 'codex-app-server', version: 4 } },
    })
    if (first.message.source.kind !== 'model') throw new Error('expected model replay state')
    expect(JSON.stringify(first.message.source.replayState)).not.toContain('custom_tool_call')
    const call = toolCall(first.message)
    expect(call.name).toBe(tool.name)
    expect(JSON.parse(call.arguments)).toEqual({ value: ARGUMENT_SENTINEL })

    const result = createToolResultMessage({
      callId: call.id,
      content: [{ type: 'text', text: RESPONSE_SENTINEL }],
      isError: false,
    })
    const queued = createUserMessage({
      source: { kind: 'plugin', plugin: 'queued-inbox' },
      content: [{
        type: 'text',
        text: `The completed tool result is authoritative. Reply with exactly ${RESPONSE_SENTINEL}.`,
      }],
    })
    const second = await assemble(ctx, [user, first.message, result, queued])
    expect(second.finish).toEqual({ kind: 'stop' })
    expect(responseText(second.message).trim()).toBe(RESPONSE_SENTINEL)

    const followUp = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: `Reply with exactly ${CACHE_SENTINEL}. Do not use a tool.` }],
    })
    const third = await assemble(ctx, [user, first.message, result, queued, second.message, followUp])
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
    expect(cacheEvidence.handles, JSON.stringify(cacheEvidence, null, 2)).toBe(1)

    const imageFollowUp = createUserMessage({
      source: { kind: 'user' },
      content: [
        { type: 'text', text: `Reply with exactly ${IMAGE_SENTINEL}. Do not use a tool or describe the image.` },
        { type: 'image', attachment: IMAGE_REF },
      ],
    })
    const fourth = await assemble(ctx, [
      user,
      first.message,
      result,
      queued,
      second.message,
      followUp,
      third.message,
      imageFollowUp,
    ])
    expect(fourth.finish).toEqual({ kind: 'stop' })
    expect(responseText(fourth.message).trim()).toBe(IMAGE_SENTINEL)
    expect(readImage).toHaveBeenCalledOnce()
    expect(JSON.stringify(fourth.message)).not.toContain(IMAGE_BASE64)

    expect(handles).toHaveLength(1)
    await ctx.fiber.dispose()
    const contextIndex = contexts.indexOf(ctx)
    if (contextIndex >= 0) contexts.splice(contextIndex, 1)
    for (const handle of handles) await expect(handle.waitForExit()).resolves.toBe(true)
  })
})
