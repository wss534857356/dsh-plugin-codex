/** Durable projection of Codex-native image outputs. */

import { createHash } from 'node:crypto'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { CodexAppServerEvent, JsonValue } from './runner.ts'

const IMAGE_MARKER_KIND = 'dsh-image-attachment'
const IMAGE_MARKER_VERSION = 1
const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

interface JsonObject {
  readonly [key: string]: unknown
}

/** Attachment operations needed by the Codex image bridge. */
export interface CodexImageStorePort {
  readonly imageLimits: ImageAttachmentLimits
  validateImage(input: SaveImageAttachment): Promise<void>
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
}

/** One App Server event after binary outputs have moved to durable attachments. */
export interface ExternalizedCodexEvent {
  readonly event: CodexAppServerEvent
  readonly images: readonly ImageAttachmentRef[]
}

interface DecodedImage {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly name?: string
}

interface PendingOutputImage {
  readonly index: number
  readonly input: DecodedImage
}

function object(value: unknown, label: string, code: 'INVALID_HISTORY' | 'MALFORMED_RESPONSE'): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LlmError(`${label} must be a JSON object`, code)
  }
  return value as JsonObject
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new LlmError(`Codex history contains invalid ${label}`, 'INVALID_HISTORY')
  }
  return value as number
}

function attachmentRef(value: unknown, label: string): ImageAttachmentRef {
  const candidate = object(value, label, 'INVALID_HISTORY')
  if (typeof candidate.attachmentId !== 'string' || candidate.attachmentId.length === 0
    || typeof candidate.mediaType !== 'string'
    || !IMAGE_MEDIA_TYPES.has(candidate.mediaType as ImageMediaType)
    || (candidate.name !== undefined && (typeof candidate.name !== 'string' || candidate.name.length === 0))) {
    throw new LlmError(`Codex history contains invalid ${label}`, 'INVALID_HISTORY')
  }
  return {
    attachmentId: AttachmentId(candidate.attachmentId),
    mediaType: candidate.mediaType as ImageMediaType,
    bytes: positiveInteger(candidate.bytes, `${label}.bytes`),
    width: positiveInteger(candidate.width, `${label}.width`),
    height: positiveInteger(candidate.height, `${label}.height`),
    ...(candidate.name === undefined ? {} : { name: candidate.name as string }),
  }
}

function referenceValue(ref: ImageAttachmentRef): JsonValue {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
}

function attachmentMarker(ref: ImageAttachmentRef): JsonValue {
  return {
    kind: IMAGE_MARKER_KIND,
    version: IMAGE_MARKER_VERSION,
    attachment: referenceValue(ref),
  }
}

function markerReference(value: unknown, label: string): ImageAttachmentRef {
  const marker = object(value, label, 'INVALID_HISTORY')
  if (marker.kind !== IMAGE_MARKER_KIND || marker.version !== IMAGE_MARKER_VERSION) {
    throw new LlmError(`Codex history contains invalid ${label}`, 'INVALID_HISTORY')
  }
  return attachmentRef(marker.attachment, `${label}.attachment`)
}

function displayName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const normalized = value.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  return name.length === 0 ? undefined : name
}

function decodedBase64(
  encoded: string,
  mediaType: ImageMediaType,
  limits: ImageAttachmentLimits,
  label: string,
  name?: string,
): DecodedImage {
  const maximumEncodedBytes = 4 * Math.ceil(limits.maxImageBytes / 3)
  if (encoded.length === 0
    || encoded.length > maximumEncodedBytes
    || encoded.length % 4 !== 0
    || !BASE64.test(encoded)) {
    throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  const data = Buffer.from(encoded, 'base64')
  if (data.byteLength === 0
    || data.byteLength > limits.maxImageBytes
    || data.toString('base64') !== encoded) {
    throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  return { data, mediaType, ...(name === undefined ? {} : { name }) }
}

function decodedDataUrl(
  value: string,
  limits: ImageAttachmentLimits,
  label: string,
): DecodedImage | undefined {
  if (!value.startsWith('data:')) return undefined
  const separator = value.indexOf(',')
  if (separator < 0) throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  const header = value.slice(5, separator)
  const match = /^(image\/(?:png|jpeg|webp|gif));base64$/u.exec(header)
  if (match === null) throw new LlmError(`Codex App Server returned unsupported ${label}`, 'UNSUPPORTED_CONTENT')
  return decodedBase64(
    value.slice(separator + 1),
    match[1] as ImageMediaType,
    limits,
    label,
  )
}

function imageKey(input: DecodedImage): string {
  return `${input.mediaType}:${createHash('sha256').update(input.data).digest('hex')}`
}

/**
 * Move native image bytes out of provider events and restore them only for App Server injection.
 * One instance belongs to one model request.
 */
export class NativeImageBridge {
  private readonly references = new Map<string, ImageAttachmentRef>()
  private readonly emitted = new Set<string>()
  private readonly hydrated = new Map<string, Promise<string>>()
  private storeValue: CodexImageStorePort | undefined

  constructor(private readonly resolveStore: () => CodexImageStorePort | undefined) {}

  /** Mark images already present in durable history so provider echoes are not published again. */
  rememberHistory(history: readonly JsonValue[]): void {
    for (const [itemIndex, item] of history.entries()) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)
        || item.type !== 'function_call_output' || !Array.isArray(item.output)) continue
      for (const [contentIndex, value] of item.output.entries()) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)
          || value.type !== 'input_image' || typeof value.image_url === 'string') continue
        const ref = markerReference(
          value.image_url,
          `history[${itemIndex}].output[${contentIndex}].image_url`,
        )
        this.emitted.add(String(ref.attachmentId))
      }
    }
  }

  /** Externalize binary fields in one live App Server event. */
  async externalize(event: CodexAppServerEvent): Promise<ExternalizedCodexEvent> {
    if (event.kind !== 'notification') return { event, images: [] }
    if (event.method === 'item/completed') return this.externalizeImageGeneration(event)
    if (event.method === 'rawResponseItem/completed') return this.externalizeRawOutput(event)
    return { event, images: [] }
  }

  /** Replace durable attachment markers with verified data URLs for App Server history injection. */
  async hydrateHistory(history: readonly JsonValue[], signal?: AbortSignal): Promise<JsonValue[]> {
    this.rememberHistory(history)
    return Promise.all(history.map((item, index) => this.hydrateItem(item, `history[${index}]`, signal)))
  }

  private store(): CodexImageStorePort {
    this.storeValue ??= this.resolveStore()
    if (this.storeValue === undefined) {
      throw new LlmError(
        'Codex native image output requires the durable attachment service',
        'UNSUPPORTED_CONTENT',
      )
    }
    return this.storeValue
  }

  private async save(input: DecodedImage): Promise<ImageAttachmentRef> {
    const key = imageKey(input)
    const known = this.references.get(key)
    if (known !== undefined) {
      if (known.name !== undefined || input.name === undefined) return known
      const named = { ...known, name: input.name }
      this.references.set(key, named)
      return named
    }
    const saved = await this.store().saveImage(input)
    this.references.set(key, saved)
    return saved
  }

  private publish(ref: ImageAttachmentRef): ImageAttachmentRef[] {
    const id = String(ref.attachmentId)
    if (this.emitted.has(id)) return []
    this.emitted.add(id)
    return [ref]
  }

  private async externalizeImageGeneration(
    event: Extract<CodexAppServerEvent, { readonly kind: 'notification' }>,
  ): Promise<ExternalizedCodexEvent> {
    const current = object(event.params.item, 'Codex image-generation item', 'MALFORMED_RESPONSE')
    if (current.type !== 'imageGeneration') return { event, images: [] }
    if (typeof current.result !== 'string') {
      throw new LlmError('Codex App Server returned invalid image-generation result', 'MALFORMED_RESPONSE')
    }
    if (current.result.length === 0) {
      if (current.status === 'completed') {
        throw new LlmError('Codex App Server completed image generation without image bytes', 'MALFORMED_RESPONSE')
      }
      return { event, images: [] }
    }
    const store = this.store()
    const input = decodedBase64(
      current.result,
      'image/png',
      store.imageLimits,
      'image-generation base64',
      displayName(current.savedPath),
    )
    const ref = await this.save(input)
    return {
      event: {
        ...event,
        params: {
          ...event.params,
          item: { ...current, result: attachmentMarker(ref) },
        },
      },
      images: this.publish(ref),
    }
  }

  private async externalizeRawOutput(
    event: Extract<CodexAppServerEvent, { readonly kind: 'notification' }>,
  ): Promise<ExternalizedCodexEvent> {
    const current = object(event.params.item, 'Codex raw response item', 'MALFORMED_RESPONSE')
    if (current.type !== 'function_call_output' || !Array.isArray(current.output)) {
      return { event, images: [] }
    }
    const pending: PendingOutputImage[] = []
    for (const [index, value] of current.output.entries()) {
      const content = object(value, `Codex function output content ${index}`, 'MALFORMED_RESPONSE')
      if (content.type !== 'input_image' || typeof content.image_url !== 'string') continue
      if (!content.image_url.startsWith('data:')) continue
      const input = decodedDataUrl(
        content.image_url,
        this.store().imageLimits,
        `function output image ${index}`,
      )
      if (input !== undefined) pending.push({ index, input })
    }
    if (pending.length === 0) return { event, images: [] }
    const store = this.store()
    const totalBytes = pending.reduce((total, entry) => total + entry.input.data.byteLength, 0)
    if (pending.length > store.imageLimits.maxImagesPerMessage
      || totalBytes > store.imageLimits.maxMessageImageBytes) {
      throw new LlmError('Codex App Server returned too many image bytes in one tool output', 'MALFORMED_RESPONSE')
    }
    await Promise.all(pending
      .filter(entry => !this.references.has(imageKey(entry.input)))
      .map(entry => store.validateImage(entry.input)))
    const output = [...current.output]
    const images: ImageAttachmentRef[] = []
    for (const entry of pending) {
      const ref = await this.save(entry.input)
      const content = object(output[entry.index], `Codex function output content ${entry.index}`, 'MALFORMED_RESPONSE')
      output[entry.index] = { ...content, image_url: attachmentMarker(ref) }
      images.push(...this.publish(ref))
    }
    return {
      event: {
        ...event,
        params: {
          ...event.params,
          item: { ...current, output },
        },
      },
      images,
    }
  }

  private async hydrateItem(item: JsonValue, label: string, signal?: AbortSignal): Promise<JsonValue> {
    if (item === null || typeof item !== 'object' || Array.isArray(item)
      || item.type !== 'function_call_output' || !Array.isArray(item.output)) return item
    const output = await Promise.all(item.output.map(async (value, index): Promise<JsonValue> => {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || value.type !== 'input_image') {
        return value
      }
      if (typeof value.image_url === 'string') return value
      const ref = markerReference(value.image_url, `${label}.output[${index}].image_url`)
      return { ...value, image_url: await this.dataUrl(ref, signal) }
    }))
    return { ...item, output }
  }

  private dataUrl(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<string> {
    const key = JSON.stringify(referenceValue(ref))
    let task = this.hydrated.get(key)
    if (task === undefined) {
      task = this.store().readImage(ref, signal).then((stored) => {
        const input = { data: stored.data, mediaType: stored.ref.mediaType }
        this.references.set(imageKey(input), stored.ref)
        this.emitted.add(String(stored.ref.attachmentId))
        return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
      })
      this.hydrated.set(key, task)
    }
    return task
  }
}
