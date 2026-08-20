import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { OFFLOADED_IMAGE_TEXT } from '@deepseek-ai/dsh-llm'
import {
  NativeImageBridge,
  boundRequestImageHistory,
  imageAttachmentMarker,
} from '../src/images.ts'
import type { CodexImageStorePort } from '../src/images.ts'
import type { CodexAppServerEvent, JsonValue } from '../src/runner.ts'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG = Buffer.from(PNG_BASE64, 'base64')
const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:image-1'),
  mediaType: 'image/png',
  bytes: PNG.byteLength,
  width: 1,
  height: 1,
  name: 'generated.png',
}

function imageStore(): CodexImageStorePort {
  return {
    imageLimits: {
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 8,
      maxMessageImageBytes: 20 * 1024 * 1024,
      maxImagePixels: 20_000_000,
      maxImageDimension: 2_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    validateImage: vi.fn(async () => {}),
    saveImage: vi.fn(async input => ({ ...IMAGE_REF, ...(input.name === undefined ? {} : { name: input.name }) })),
    readImage: vi.fn(async ref => ({ ref, data: PNG })),
  }
}

function imageCompleted(result = PNG_BASE64): CodexAppServerEvent {
  return {
    kind: 'notification',
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'imageGeneration',
        id: 'image-1',
        status: 'completed',
        result,
        savedPath: 'C:\\Users\\test\\.codex\\generated_images\\generated.png',
      },
    },
  }
}

function rawImageOutput(): CodexAppServerEvent {
  return {
    kind: 'notification',
    method: 'rawResponseItem/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'function_call_output',
        id: 'output-1',
        call_id: 'call-1',
        output: [
          { type: 'input_text', text: 'generated' },
          { type: 'input_image', image_url: `data:image/png;base64,${PNG_BASE64}`, detail: 'high' },
        ],
      },
    },
  }
}

describe('NativeImageBridge', () => {
  it('externalizes duplicate native payloads once and rehydrates replay from the attachment', async () => {
    const store = imageStore()
    const bridge = new NativeImageBridge(() => store)

    const completed = await bridge.externalize(imageCompleted())
    expect(completed.images).toEqual([IMAGE_REF])
    expect(JSON.stringify(completed.event)).not.toContain(PNG_BASE64)
    expect(completed.event).toMatchObject({
      params: {
        item: {
          result: {
            kind: 'dsh-image-attachment',
            version: 1,
            attachment: { attachmentId: 'sha256:image-1', name: 'generated.png' },
          },
        },
      },
    })

    const raw = await bridge.externalize(rawImageOutput())
    expect(raw.images).toEqual([])
    expect(JSON.stringify(raw.event)).not.toContain(PNG_BASE64)
    expect(store.saveImage).toHaveBeenCalledOnce()
    expect(store.validateImage).not.toHaveBeenCalled()

    if (raw.event.kind !== 'notification') throw new Error('expected a notification')
    const durable = raw.event.params.item as JsonValue
    const hydrated = await bridge.hydrateHistory([durable])
    expect(hydrated).toMatchObject([{
      output: [
        { type: 'input_text', text: 'generated' },
        { type: 'input_image', image_url: `data:image/png;base64,${PNG_BASE64}`, detail: 'high' },
      ],
    }])
    expect(store.readImage).toHaveBeenCalledOnce()

    const resumed = new NativeImageBridge(() => store)
    await resumed.hydrateHistory([durable])
    const echoed = await resumed.externalize(rawImageOutput())
    expect(echoed.images).toEqual([])
    expect(store.saveImage).toHaveBeenCalledOnce()
  })

  it('fails a completed image without bytes before publishing an attachment', async () => {
    const store = imageStore()
    const bridge = new NativeImageBridge(() => store)
    await expect(bridge.externalize(imageCompleted(''))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(store.saveImage).not.toHaveBeenCalled()
  })

  it('validates and publishes an image that appears only in a raw tool output', async () => {
    const store = imageStore()
    const bridge = new NativeImageBridge(() => store)
    const raw = await bridge.externalize(rawImageOutput())
    expect(raw.images).toEqual([IMAGE_REF])
    expect(store.validateImage).toHaveBeenCalledOnce()
    expect(store.saveImage).toHaveBeenCalledOnce()
    expect(JSON.stringify(raw.event)).not.toContain(PNG_BASE64)
  })

  it('fails image output when the Harness attachment service is unavailable', async () => {
    const bridge = new NativeImageBridge(() => undefined)
    await expect(bridge.externalize(imageCompleted())).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('creates an attachment marker and hydrates it in a user history message', async () => {
    const store = imageStore()
    const bridge = new NativeImageBridge(() => store)
    const marker = imageAttachmentMarker(IMAGE_REF)
    expect(marker).toEqual({
      kind: 'dsh-image-attachment',
      version: 1,
      attachment: {
        attachmentId: 'sha256:image-1',
        mediaType: 'image/png',
        bytes: PNG.byteLength,
        width: 1,
        height: 1,
        name: 'generated.png',
      },
    })

    await expect(bridge.hydrateHistory([{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: marker, detail: 'original' }],
    }])).resolves.toEqual([{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_image',
        image_url: `data:image/png;base64,${PNG_BASE64}`,
        detail: 'original',
      }],
    }])
  })

  it('hydrates text/image/text user content to exact App Server v2 shapes', async () => {
    const store = imageStore()
    const bridge = new NativeImageBridge(() => store)
    await expect(bridge.hydrateUserInput([
      { type: 'input_text', text: 'before' },
      { type: 'input_image', image_url: imageAttachmentMarker(IMAGE_REF), detail: 'high' },
      { type: 'input_text', text: 'after' },
    ])).resolves.toEqual([
      { type: 'text', text: 'before', text_elements: [] },
      { type: 'image', url: `data:image/png;base64,${PNG_BASE64}`, detail: 'high' },
      { type: 'text', text: 'after', text_elements: [] },
    ])
  })

  it('hydrates structured tool results with exact camel-case content item shapes', async () => {
    const store = imageStore()
    const bridge = new NativeImageBridge(() => store)
    await expect(bridge.hydrateToolResult({
      callId: 'call-1',
      output: [
        { type: 'input_text', text: 'caption' },
        { type: 'input_image', image_url: imageAttachmentMarker(IMAGE_REF) },
      ],
      success: true,
    })).resolves.toEqual({
      callId: 'call-1',
      contentItems: [
        { type: 'inputText', text: 'caption' },
        { type: 'inputImage', imageUrl: `data:image/png;base64,${PNG_BASE64}` },
      ],
      success: true,
    })
  })

  it('bounds request images oldest-first and never reads omitted attachments', async () => {
    const refs = [1, 2, 3].map(index => ({
      ...IMAGE_REF,
      attachmentId: AttachmentId(`sha256:image-${index}`),
      bytes: 3,
      name: `image-${index}.png`,
    }))
    const history: JsonValue[] = refs.map(ref => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: imageAttachmentMarker(ref) }],
    }))
    const bounded = boundRequestImageHistory(history, 8)
    expect(bounded).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: OFFLOADED_IMAGE_TEXT }] },
      history[1],
      history[2],
    ])

    const store = imageStore()
    const bridge = new NativeImageBridge(() => store)
    await bridge.hydrateHistory(bounded)
    expect(store.readImage).toHaveBeenCalledTimes(2)
    expect(store.readImage).toHaveBeenNthCalledWith(1, refs[1], undefined)
    expect(store.readImage).toHaveBeenNthCalledWith(2, refs[2], undefined)
    expect(store.readImage).not.toHaveBeenCalledWith(refs[0], expect.anything())
  })

  it('externalizes a supplied Harness tool image echo without publishing it', async () => {
    const store = imageStore()
    const bridge = new NativeImageBridge(() => store)
    bridge.rememberHistory([{
      type: 'function_call',
      namespace: 'deepseek_harness',
      call_id: 'call-1',
    }])

    const result = await bridge.externalize(rawImageOutput())
    expect(result.images).toEqual([])
    expect(JSON.stringify(result.event)).not.toContain(PNG_BASE64)
    expect(store.saveImage).toHaveBeenCalledOnce()
  })

  it('does not republish an unnamespaced raw echo of a supplied user image', async () => {
    const store = imageStore()
    const bridge = new NativeImageBridge(() => store)
    await bridge.hydrateUserInput([{
      type: 'input_image',
      image_url: imageAttachmentMarker(IMAGE_REF),
    }])

    const result = await bridge.externalize(rawImageOutput())
    expect(result.images).toEqual([])
    expect(JSON.stringify(result.event)).not.toContain(PNG_BASE64)
  })

  it('publishes a generated image only once', async () => {
    const store = imageStore()
    const bridge = new NativeImageBridge(() => store)
    await expect(bridge.externalize(imageCompleted())).resolves.toMatchObject({ images: [IMAGE_REF] })
    await expect(bridge.externalize(imageCompleted())).resolves.toMatchObject({ images: [] })
    expect(store.saveImage).toHaveBeenCalledOnce()
  })

  it('rejects an attachment read whose returned reference does not match', async () => {
    const store = imageStore()
    vi.mocked(store.readImage).mockResolvedValue({
      ref: { ...IMAGE_REF, attachmentId: AttachmentId('sha256:other') },
      data: PNG,
    })
    const bridge = new NativeImageBridge(() => store)
    await expect(bridge.hydrateUserInput([
      { type: 'input_image', image_url: imageAttachmentMarker(IMAGE_REF) },
    ])).rejects.toMatchObject({ code: 'INVALID_HISTORY' })
  })

  it('propagates the abort signal and abort rejection from attachment reads', async () => {
    const store = imageStore()
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    vi.mocked(store.readImage).mockImplementation(async (_ref, signal) => {
      expect(signal).toBe(controller.signal)
      throw signal?.reason
    })
    const bridge = new NativeImageBridge(() => store)
    await expect(bridge.hydrateHistory([{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: imageAttachmentMarker(IMAGE_REF) }],
    }], controller.signal)).rejects.toBe(controller.signal.reason)
    expect(store.readImage).toHaveBeenCalledWith(IMAGE_REF, controller.signal)
  })
})
