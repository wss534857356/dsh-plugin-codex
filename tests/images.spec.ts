import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { NativeImageBridge } from '../src/images.ts'
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
})
